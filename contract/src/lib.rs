//! SIEGE vault: two-key custody for an AI agent's NEAR.
//!
//! The vault holds the funds. The agent holds a function-call access key that the protocol lets call
//! only `spend`. `spend` pays out only with an approval signed by a separate guard key (the Mandate
//! guard signs after it judges the spend's intent), and then only inside hard caps the owner set,
//! whatever the guard signed:
//!
//!   message   = "siege-vault-v1|<network>|<vault id>|<receiver>|<amount yocto>|<nonce>|<expires_at ns>"
//!   guard_sig = ed25519(guard secret key, message), checked with env::ed25519_verify
//!
//! A compromised agent (it has the function-call key) cannot pay without a fresh guard signature.
//! A compromised guard (it signs anything) is bounded by the caps: per transaction, per 24 clock
//! hours, and a smaller budget for payees not on the owner's payee list.
//!
//! Refusals do not panic: `spend` returns `SpendOutcome { ok: false, reason }` and emits a NEP-297
//! `spend_refused` event, so every refusal is visible on chain with its reason code. Owner methods
//! require the owner account and 1 yoctoNEAR, which a function-call key cannot attach, so they need
//! a full-access key of the owner.
//!
//! Arguments and results are Borsh, not JSON: leaving serde_json out halves the wasm (about 80 KB
//! after wasm-opt), and so the storage stake. Events stay JSON. `src/vault/borsh.ts` encodes calls.

use near_sdk::store::LookupSet;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, CurveType, NearToken,
    PanicOnDefault, Promise, PublicKey,
};

pub const MESSAGE_TAG: &str = "siege-vault-v1";
pub const HOUR_NS: u64 = 3_600_000_000_000;
pub const WINDOW_HOURS: u64 = 24;
const DEFAULT_MAX_TTL_NS: u64 = HOUR_NS;
const MAX_PAYEES: usize = 100;
/// Bytes of headroom kept above current storage when checking the balance (a new nonce entry, etc.).
const STORAGE_HEADROOM_BYTES: u64 = 512;

// Reason codes.
pub const PAUSED: &str = "PAUSED";
pub const NOT_AGENT: &str = "NOT_AGENT";
pub const BAD_AMOUNT: &str = "BAD_AMOUNT";
pub const BAD_SIGNATURE: &str = "BAD_SIGNATURE";
pub const APPROVAL_EXPIRED: &str = "APPROVAL_EXPIRED";
pub const EXPIRY_TOO_FAR: &str = "EXPIRY_TOO_FAR";
pub const NONCE_REUSED: &str = "NONCE_REUSED";
pub const BAD_RECEIVER: &str = "BAD_RECEIVER";
pub const RECEIVER_NOT_ALLOWED: &str = "RECEIVER_NOT_ALLOWED";
pub const PER_TX_CAP: &str = "PER_TX_CAP";
pub const DAILY_CAP: &str = "DAILY_CAP";
pub const NOVEL_PAYEE_BUDGET: &str = "NOVEL_PAYEE_BUDGET";
pub const INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Nonces,
}

/// Spend in one clock hour. 24 of these form the rolling window.
#[derive(Clone, Copy, Default)]
#[near(serializers = [borsh])]
pub struct Bucket {
    hour: u64,
    total: u128,
    novel: u128,
}

#[derive(Debug, PartialEq)]
#[near(serializers = [borsh])]
pub struct SpendOutcome {
    pub ok: bool,
    pub reason: Option<String>,
}

#[near(serializers = [borsh])]
pub struct PolicyView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub guard_pk: PublicKey,
    pub network: String,
    pub per_tx_cap: u128,
    pub daily_cap: u128,
    pub novel_daily_cap: u128,
    pub payees: Vec<AccountId>,
    pub allowlist_only: bool,
    pub paused: bool,
    pub max_ttl_secs: u64,
}

#[near(serializers = [borsh])]
pub struct StatsView {
    pub total_spent: u128,
    pub spends: u64,
    pub refusals: u64,
    pub window_spent: u128,
    pub window_novel_spent: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    guard_pk: PublicKey,
    network: String,
    per_tx_cap: u128,
    daily_cap: u128,
    novel_daily_cap: u128,
    payees: Vec<AccountId>,
    allowlist_only: bool,
    paused: bool,
    max_ttl_ns: u64,
    used_nonces: LookupSet<u64>,
    buckets: Vec<Bucket>,
    total_spent: u128,
    spends: u64,
    refusals: u64,
}

pub fn canonical_message(network: &str, contract: &str, receiver: &str, amount: u128, nonce: u64, expires_at: u64) -> String {
    format!("{MESSAGE_TAG}|{network}|{contract}|{receiver}|{amount}|{nonce}|{expires_at}")
}

/// NEP-297 event. `data` is one JSON object; every value in it is an account id, a decimal number, a
/// reason code or a base58 key, none of which need escaping.
fn emit(event: &str, data: &str) {
    env::log_str(&format!(r#"EVENT_JSON:{{"standard":"siege_vault","version":"1.0.0","event":"{event}","data":[{data}]}}"#));
}

fn require_ed25519(pk: &PublicKey) {
    require!(pk.curve_type() == CurveType::ED25519, "guard key must be ed25519");
}

#[near]
impl Vault {
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        #[serializer(borsh)] owner: AccountId,
        #[serializer(borsh)] agent: AccountId,
        #[serializer(borsh)] guard_pk: PublicKey,
        #[serializer(borsh)] network: String,
        #[serializer(borsh)] per_tx_cap: u128,
        #[serializer(borsh)] daily_cap: u128,
        #[serializer(borsh)] novel_daily_cap: u128,
        #[serializer(borsh)] payees: Vec<AccountId>,
        #[serializer(borsh)] allowlist_only: bool,
    ) -> Self {
        require_ed25519(&guard_pk);
        let mut v = Self {
            owner,
            agent,
            guard_pk,
            network,
            per_tx_cap: 0,
            daily_cap: 0,
            novel_daily_cap: 0,
            payees: vec![],
            allowlist_only,
            paused: false,
            max_ttl_ns: DEFAULT_MAX_TTL_NS,
            used_nonces: LookupSet::new(Key::Nonces),
            buckets: vec![Bucket::default(); WINDOW_HOURS as usize],
            total_spent: 0,
            spends: 0,
            refusals: 0,
        };
        v.apply_policy(per_tx_cap, daily_cap, novel_daily_cap, None);
        v.apply_payees(payees);
        v
    }

    // ---------------------------------------------------------------- agent

    /// Pay `amount` yoctoNEAR to `receiver` under a guard approval. Never panics on a refusal.
    #[result_serializer(borsh)]
    pub fn spend(
        &mut self,
        #[serializer(borsh)] receiver: AccountId,
        #[serializer(borsh)] amount: u128,
        #[serializer(borsh)] nonce: u64,
        #[serializer(borsh)] expires_at: u64,
        #[serializer(borsh)] guard_sig: Vec<u8>,
    ) -> SpendOutcome {
        match self.check_and_record(&receiver, amount, nonce, expires_at, &guard_sig) {
            Ok(novel) => {
                Promise::new(receiver.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
                emit("spend", &format!(r#"{{"receiver":"{receiver}","amount":"{amount}","nonce":"{nonce}","novel_payee":{novel}}}"#));
                SpendOutcome { ok: true, reason: None }
            }
            Err(reason) => {
                self.refusals += 1;
                emit("spend_refused", &format!(r#"{{"receiver":"{receiver}","amount":"{amount}","nonce":"{nonce}","reason":"{reason}"}}"#));
                SpendOutcome { ok: false, reason: Some(reason.to_string()) }
            }
        }
    }

    fn check_and_record(&mut self, receiver: &AccountId, amount: u128, nonce: u64, expires_at: u64, sig: &[u8]) -> Result<bool, &'static str> {
        if self.paused {
            return Err(PAUSED);
        }
        if env::predecessor_account_id() != self.agent {
            return Err(NOT_AGENT);
        }
        if amount == 0 {
            return Err(BAD_AMOUNT);
        }
        // Signature before anything stateful: an unsigned attempt changes nothing and learns nothing.
        let sig: &[u8; 64] = sig.try_into().map_err(|_| BAD_SIGNATURE)?;
        let pk: &[u8; 32] = self.guard_pk.as_bytes()[1..].try_into().map_err(|_| BAD_SIGNATURE)?;
        let msg = canonical_message(&self.network, env::current_account_id().as_str(), receiver.as_str(), amount, nonce, expires_at);
        if !env::ed25519_verify(sig, msg.as_bytes(), pk) {
            return Err(BAD_SIGNATURE);
        }
        let now = env::block_timestamp();
        if now >= expires_at {
            return Err(APPROVAL_EXPIRED);
        }
        if expires_at - now > self.max_ttl_ns {
            return Err(EXPIRY_TOO_FAR);
        }
        if self.used_nonces.contains(&nonce) {
            return Err(NONCE_REUSED);
        }
        // A genuine, fresh approval is single use from here on, whether or not the caps let it pay.
        self.used_nonces.insert(nonce);

        if *receiver == env::current_account_id() {
            return Err(BAD_RECEIVER);
        }
        let listed = self.payees.contains(receiver);
        if self.allowlist_only && !listed {
            return Err(RECEIVER_NOT_ALLOWED);
        }
        if amount > self.per_tx_cap {
            return Err(PER_TX_CAP);
        }
        let hour = now / HOUR_NS;
        let (total, novel_total) = self.window(hour);
        if total + amount > self.daily_cap {
            return Err(DAILY_CAP);
        }
        let novel = !listed;
        if novel && novel_total + amount > self.novel_daily_cap {
            return Err(NOVEL_PAYEE_BUDGET);
        }
        let reserve = (env::storage_usage() + STORAGE_HEADROOM_BYTES) as u128 * env::storage_byte_cost().as_yoctonear();
        if env::account_balance().as_yoctonear().saturating_sub(reserve) < amount {
            return Err(INSUFFICIENT_BALANCE);
        }

        let b = &mut self.buckets[(hour % WINDOW_HOURS) as usize];
        if b.hour != hour {
            *b = Bucket { hour, total: 0, novel: 0 };
        }
        b.total += amount;
        if novel {
            b.novel += amount;
        }
        self.total_spent += amount;
        self.spends += 1;
        Ok(novel)
    }

    /// Spend in the current clock hour and the 23 before it: (total, to payees not on the list).
    fn window(&self, hour: u64) -> (u128, u128) {
        self.buckets
            .iter()
            .filter(|b| b.total > 0 && b.hour <= hour && b.hour + WINDOW_HOURS > hour)
            .fold((0, 0), |(t, n), b| (t + b.total, n + b.novel))
    }

    // ---------------------------------------------------------------- owner

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "OWNER_ONLY");
    }

    fn apply_policy(&mut self, per_tx_cap: u128, daily_cap: u128, novel_daily_cap: u128, max_ttl_secs: Option<u64>) {
        require!(per_tx_cap <= daily_cap, "per_tx_cap must not exceed daily_cap");
        require!(novel_daily_cap <= daily_cap, "novel_daily_cap must not exceed daily_cap");
        self.per_tx_cap = per_tx_cap;
        self.daily_cap = daily_cap;
        self.novel_daily_cap = novel_daily_cap;
        if let Some(s) = max_ttl_secs {
            require!((1..=86_400).contains(&s), "max_ttl_secs must be 1..=86400");
            self.max_ttl_ns = s * 1_000_000_000;
        }
    }

    fn apply_payees(&mut self, payees: Vec<AccountId>) {
        require!(payees.len() <= MAX_PAYEES, "too many payees");
        self.payees = payees;
    }

    #[payable]
    pub fn set_policy(
        &mut self,
        #[serializer(borsh)] per_tx_cap: u128,
        #[serializer(borsh)] daily_cap: u128,
        #[serializer(borsh)] novel_daily_cap: u128,
        #[serializer(borsh)] max_ttl_secs: Option<u64>,
    ) {
        self.assert_owner();
        self.apply_policy(per_tx_cap, daily_cap, novel_daily_cap, max_ttl_secs);
        emit("policy_set", &format!(r#"{{"per_tx_cap":"{per_tx_cap}","daily_cap":"{daily_cap}","novel_daily_cap":"{novel_daily_cap}"}}"#));
    }

    #[payable]
    pub fn set_payees(&mut self, #[serializer(borsh)] payees: Vec<AccountId>, #[serializer(borsh)] allowlist_only: bool) {
        self.assert_owner();
        self.apply_payees(payees);
        self.allowlist_only = allowlist_only;
        emit("payees_set", &format!(r#"{{"count":{},"allowlist_only":{allowlist_only}}}"#, self.payees.len()));
    }

    #[payable]
    pub fn set_guard(&mut self, #[serializer(borsh)] guard_pk: PublicKey) {
        self.assert_owner();
        require_ed25519(&guard_pk);
        self.guard_pk = guard_pk;
        emit("guard_set", &format!(r#"{{"guard_pk":"{}"}}"#, String::from(&self.guard_pk)));
    }

    #[payable]
    pub fn set_agent(&mut self, #[serializer(borsh)] agent: AccountId) {
        self.assert_owner();
        self.agent = agent;
        emit("agent_set", &format!(r#"{{"agent":"{}"}}"#, self.agent));
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", "{}");
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", "{}");
    }

    /// Return funds to the owner.
    #[payable]
    pub fn withdraw(&mut self, #[serializer(borsh)] amount: u128) -> Promise {
        self.assert_owner();
        emit("withdraw", &format!(r#"{{"amount":"{amount}"}}"#));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------------------------------------------------------------- views

    #[result_serializer(borsh)]
    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            guard_pk: self.guard_pk.clone(),
            network: self.network.clone(),
            per_tx_cap: self.per_tx_cap,
            daily_cap: self.daily_cap,
            novel_daily_cap: self.novel_daily_cap,
            payees: self.payees.clone(),
            allowlist_only: self.allowlist_only,
            paused: self.paused,
            max_ttl_secs: self.max_ttl_ns / 1_000_000_000,
        }
    }

    #[result_serializer(borsh)]
    pub fn get_stats(&self) -> StatsView {
        let (t, n) = self.window(env::block_timestamp() / HOUR_NS);
        StatsView { total_spent: self.total_spent, spends: self.spends, refusals: self.refusals, window_spent: t, window_novel_spent: n }
    }

    #[result_serializer(borsh)]
    pub fn nonce_used(&self, #[serializer(borsh)] nonce: u64) -> bool {
        self.used_nonces.contains(&nonce)
    }

    /// The exact text the guard must sign, for clients to cross-check their encoding.
    #[result_serializer(borsh)]
    pub fn approval_message(
        &self,
        #[serializer(borsh)] receiver: AccountId,
        #[serializer(borsh)] amount: u128,
        #[serializer(borsh)] nonce: u64,
        #[serializer(borsh)] expires_at: u64,
    ) -> String {
        canonical_message(&self.network, env::current_account_id().as_str(), receiver.as_str(), amount, nonce, expires_at)
    }
}

#[cfg(test)]
mod tests;
