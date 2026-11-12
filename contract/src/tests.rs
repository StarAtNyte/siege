use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const T0: u64 = 1_800_000_000_000_000_000; // ns
const VAULT: &str = "vault.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn guard() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}
fn pk_of(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn ctx(predecessor: &str, now: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(VAULT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(now)
        .account_balance(NearToken::from_near(1000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

/// whitelist-style: per tx 5, 20/24h, 2 to unlisted payees; alice and bob listed.
fn vault() -> Vault {
    ctx(VAULT, T0, 0);
    Vault::new(acc("owner.testnet"), acc(VAULT), pk_of(&guard()), "testnet".into(), 5 * NEAR, 20 * NEAR, 2 * NEAR, vec![acc("alice.testnet"), acc("bob.testnet")], false)
}

fn sig_with(k: &SigningKey, network: &str, contract: &str, to: &str, amount: u128, nonce: u64, exp: u64) -> Vec<u8> {
    k.sign(canonical_message(network, contract, to, amount, nonce, exp).as_bytes()).to_bytes().to_vec()
}
fn sig(to: &str, amount: u128, nonce: u64, exp: u64) -> Vec<u8> {
    sig_with(&guard(), "testnet", VAULT, to, amount, nonce, exp)
}

/// Spend as the agent at `now`; returns the outcome and the NEAR actually sent in receipts.
fn spend(v: &mut Vault, now: u64, to: &str, amount: u128, nonce: u64, exp: u64, s: Vec<u8>) -> (SpendOutcome, u128) {
    ctx(VAULT, now, 0);
    let o = v.spend(acc(to), amount, nonce, exp, s);
    (o, sent())
}
fn sent() -> u128 {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}
fn refused(o: &SpendOutcome, reason: &str) {
    assert_eq!(o, &SpendOutcome { ok: false, reason: Some(reason.into()) });
}

#[test]
fn golden_vector_matches_typescript_signer() {
    // Same seed, message and signature as test/vault.test.ts, so the two encoders cannot drift apart.
    let k = guard();
    let msg = canonical_message("testnet", VAULT, "alice.testnet", NEAR, 42, 1_700_000_000_000_000_000);
    assert_eq!(msg, "siege-vault-v1|testnet|vault.testnet|alice.testnet|1000000000000000000000000|42|1700000000000000000");
    let b64 = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, k.sign(msg.as_bytes()).to_bytes());
    assert_eq!(b64, "AYSStIzj30R68lLkIYa9YZtMqgNwRamyJfHmx1T0H9YbMGbC6RFcsSpursIYx6E9J4dpTGuXJtL3zumRtbDCCg==");
    assert_eq!(String::from(&pk_of(&k)), "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
}

#[test]
fn allowed_spend_pays_and_emits() {
    let mut v = vault();
    let exp = T0 + 60_000_000_000;
    let (o, out) = spend(&mut v, T0, "alice.testnet", 2 * NEAR, 1, exp, sig("alice.testnet", 2 * NEAR, 1, exp));
    assert_eq!(o, SpendOutcome { ok: true, reason: None });
    assert_eq!(out, 2 * NEAR);
    assert!(get_logs()[0].starts_with("EVENT_JSON:{") && get_logs()[0].contains("\"event\":\"spend\""));
    assert!(v.nonce_used(1));
    assert_eq!(v.get_stats().window_spent, 2 * NEAR);
}

#[test]
fn spend_without_signature_refused() {
    let mut v = vault();
    let (o, out) = spend(&mut v, T0, "alice.testnet", NEAR, 1, T0 + 1_000, vec![]);
    refused(&o, BAD_SIGNATURE);
    assert_eq!(out, 0);
    assert!(get_logs()[0].contains("\"event\":\"spend_refused\"") && get_logs()[0].contains(BAD_SIGNATURE));
    assert!(!v.nonce_used(1), "an unsigned attempt must not burn the nonce");
}

#[test]
fn wrong_signer_refused() {
    let mut v = vault();
    let agent_key = SigningKey::from_bytes(&[9u8; 32]); // e.g. the agent signing its own approval
    let exp = T0 + 1_000;
    let (o, out) = spend(&mut v, T0, "mallory.testnet", NEAR, 1, exp, sig_with(&agent_key, "testnet", VAULT, "mallory.testnet", NEAR, 1, exp));
    refused(&o, BAD_SIGNATURE);
    assert_eq!(out, 0);
}

#[test]
fn tampered_fields_and_other_domains_refused() {
    let mut v = vault();
    let exp = T0 + 1_000;
    let good = sig("alice.testnet", NEAR, 1, exp);
    for (to, amt, n, e) in [("mallory.testnet", NEAR, 1, exp), ("alice.testnet", 2 * NEAR, 1, exp), ("alice.testnet", NEAR, 2, exp), ("alice.testnet", NEAR, 1, exp + 1)] {
        refused(&spend(&mut v, T0, to, amt, n, e, good.clone()).0, BAD_SIGNATURE);
    }
    // A genuine guard signature for another vault, or for mainnet, does not pay here.
    refused(&spend(&mut v, T0, "alice.testnet", NEAR, 1, exp, sig_with(&guard(), "testnet", "other-vault.testnet", "alice.testnet", NEAR, 1, exp)).0, BAD_SIGNATURE);
    refused(&spend(&mut v, T0, "alice.testnet", NEAR, 1, exp, sig_with(&guard(), "mainnet", VAULT, "alice.testnet", NEAR, 1, exp)).0, BAD_SIGNATURE);
    assert_eq!(v.get_stats().spends, 0);
}

#[test]
fn replay_refused() {
    let mut v = vault();
    let exp = T0 + 60_000_000_000;
    let s = sig("alice.testnet", NEAR, 7, exp);
    assert!(spend(&mut v, T0, "alice.testnet", NEAR, 7, exp, s.clone()).0.ok);
    let (o, out) = spend(&mut v, T0 + 1, "alice.testnet", NEAR, 7, exp, s);
    refused(&o, NONCE_REUSED);
    assert_eq!(out, 0);
    assert_eq!(v.get_stats().total_spent, NEAR);
}

#[test]
fn expiry_enforced() {
    let mut v = vault();
    let exp = T0 + 1_000;
    refused(&spend(&mut v, exp, "alice.testnet", NEAR, 1, exp, sig("alice.testnet", NEAR, 1, exp)).0, APPROVAL_EXPIRED);
    let far = T0 + 2 * HOUR_NS;
    refused(&spend(&mut v, T0, "alice.testnet", NEAR, 2, far, sig("alice.testnet", NEAR, 2, far)).0, EXPIRY_TOO_FAR);
    assert!(!v.nonce_used(1) && !v.nonce_used(2));
}

#[test]
fn caps_hold_with_a_valid_signature() {
    let mut v = vault();
    let exp = T0 + 1_000_000;
    // Per transaction.
    let (o, out) = spend(&mut v, T0, "alice.testnet", 6 * NEAR, 1, exp, sig("alice.testnet", 6 * NEAR, 1, exp));
    refused(&o, PER_TX_CAP);
    assert_eq!(out, 0);
    assert!(v.nonce_used(1), "a genuine approval is single use even when refused");
    // Daily: 4 x 5 = 20 fills the window, the fifth is refused.
    for n in 2..6 {
        assert!(spend(&mut v, T0, "bob.testnet", 5 * NEAR, n, exp, sig("bob.testnet", 5 * NEAR, n, exp)).0.ok);
    }
    refused(&spend(&mut v, T0, "bob.testnet", NEAR, 6, exp, sig("bob.testnet", NEAR, 6, exp)).0, DAILY_CAP);
    // 24 clock hours later the window has rolled.
    let later = T0 + 24 * HOUR_NS;
    assert!(spend(&mut v, later, "bob.testnet", NEAR, 7, later + 1_000, sig("bob.testnet", NEAR, 7, later + 1_000)).0.ok);
}

#[test]
fn novel_payee_budget_and_allowlist() {
    let mut v = vault();
    let exp = T0 + 1_000_000;
    assert!(spend(&mut v, T0, "newvendor.testnet", 2 * NEAR, 1, exp, sig("newvendor.testnet", 2 * NEAR, 1, exp)).0.ok);
    refused(&spend(&mut v, T0, "mallory.testnet", NEAR, 2, exp, sig("mallory.testnet", NEAR, 2, exp)).0, NOVEL_PAYEE_BUDGET);
    assert!(spend(&mut v, T0, "alice.testnet", 5 * NEAR, 3, exp, sig("alice.testnet", 5 * NEAR, 3, exp)).0.ok);
    // Owner switches to allowlist-only: unlisted payees are refused outright.
    ctx("owner.testnet", T0, 1);
    v.set_payees(vec![acc("alice.testnet")], true);
    refused(&spend(&mut v, T0, "bob.testnet", NEAR, 4, exp, sig("bob.testnet", NEAR, 4, exp)).0, RECEIVER_NOT_ALLOWED);
    refused(&spend(&mut v, T0, VAULT, NEAR, 5, exp, sig(VAULT, NEAR, 5, exp)).0, BAD_RECEIVER);
}

#[test]
fn pause_blocks_spend_until_unpaused() {
    let mut v = vault();
    let exp = T0 + 1_000_000;
    ctx("owner.testnet", T0, 1);
    v.pause();
    refused(&spend(&mut v, T0, "alice.testnet", NEAR, 1, exp, sig("alice.testnet", NEAR, 1, exp)).0, PAUSED);
    ctx("owner.testnet", T0, 1);
    v.unpause();
    assert!(spend(&mut v, T0, "alice.testnet", NEAR, 1, exp, sig("alice.testnet", NEAR, 1, exp)).0.ok);
}

#[test]
fn only_the_agent_may_spend() {
    let mut v = vault();
    let exp = T0 + 1_000;
    ctx("mallory.testnet", T0, 0);
    let o = v.spend(acc("alice.testnet"), NEAR, 1, exp, sig("alice.testnet", NEAR, 1, exp));
    refused(&o, NOT_AGENT);
}

#[test]
fn insufficient_balance_refused() {
    let mut v = vault();
    ctx("owner.testnet", T0, 1);
    v.set_policy(2000 * NEAR, 2000 * NEAR, 0, None);
    let exp = T0 + 1_000;
    refused(&spend(&mut v, T0, "alice.testnet", 1000 * NEAR, 1, exp, sig("alice.testnet", 1000 * NEAR, 1, exp)).0, INSUFFICIENT_BALANCE);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_method_needs_one_yocto() {
    let mut v = vault();
    ctx("owner.testnet", T0, 0);
    v.set_policy(100 * NEAR, 100 * NEAR, 100 * NEAR, None);
}

#[test]
#[should_panic(expected = "OWNER_ONLY")]
fn agent_cannot_call_owner_methods() {
    let mut v = vault();
    ctx(VAULT, T0, 1);
    v.set_guard(pk_of(&SigningKey::from_bytes(&[9u8; 32])));
}

#[test]
#[should_panic(expected = "novel_daily_cap must not exceed daily_cap")]
fn policy_is_validated() {
    let mut v = vault();
    ctx("owner.testnet", T0, 1);
    v.set_policy(NEAR, 2 * NEAR, 3 * NEAR, None);
}

#[test]
fn rotated_guard_key_invalidates_old_signatures() {
    let mut v = vault();
    let new_guard = SigningKey::from_bytes(&[11u8; 32]);
    ctx("owner.testnet", T0, 1);
    v.set_guard(pk_of(&new_guard));
    let exp = T0 + 1_000;
    refused(&spend(&mut v, T0, "alice.testnet", NEAR, 1, exp, sig("alice.testnet", NEAR, 1, exp)).0, BAD_SIGNATURE);
    assert!(spend(&mut v, T0, "alice.testnet", NEAR, 2, exp, sig_with(&new_guard, "testnet", VAULT, "alice.testnet", NEAR, 2, exp)).0.ok);
}

/// xorshift64*: deterministic randomness without a dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Property test: random interleavings of honest approvals, a guard that signs anything, forged and
/// replayed signatures, expired approvals and time jumps. Invariants, checked after every call:
///  - conservation: NEAR leaving in receipts == sum of accepted spends == total_spent;
///  - every accepted spend carried a genuine guard signature over exactly its fields and a fresh nonce;
///  - per tx <= per_tx_cap; any 24 consecutive clock hours <= daily_cap, and <= novel_daily_cap to unlisted payees.
#[test]
fn property_conservation_and_caps() {
    for seed in 1..=4u64 {
        let mut v = vault();
        let mut r = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15));
        let forger = SigningKey::from_bytes(&[13u8; 32]);
        let payees = ["alice.testnet", "bob.testnet", "mallory.testnet", "x7f3a.testnet"];
        let mut now = T0;
        let mut nonce = 0u64;
        let mut seen: Vec<(String, u128, u64, u64, Vec<u8>)> = vec![];
        let mut accepted: Vec<(u64, u128, bool, u64)> = vec![]; // (hour, amount, novel, nonce)
        let mut out_total = 0u128;
        for _ in 0..300 {
            now += r.below(3 * HOUR_NS);
            let to = payees[r.below(4) as usize];
            let amount = (r.below(70) as u128 + 1) * NEAR / 10; // 0.1 .. 7 NEAR
            let exp = now + 1 + r.below(HOUR_NS);
            let (s, n, e, t, a, genuine) = match r.below(5) {
                0 | 1 => {
                    nonce += 1;
                    (sig(to, amount, nonce, exp), nonce, exp, to.to_string(), amount, true)
                }
                2 => {
                    nonce += 1;
                    (sig_with(&forger, "testnet", VAULT, to, amount, nonce, exp), nonce, exp, to.to_string(), amount, false)
                }
                3 if !seen.is_empty() => {
                    let (t, a, n, e, s) = seen[r.below(seen.len() as u64) as usize].clone();
                    (s, n, e, t, a, true) // replay, possibly expired by now
                }
                _ => {
                    nonce += 1;
                    let past = now.saturating_sub(1 + r.below(HOUR_NS));
                    (sig(to, amount, nonce, past), nonce, past, to.to_string(), amount, true)
                }
            };
            let (o, out) = spend(&mut v, now, &t, a, n, e, s.clone());
            out_total += out;
            if genuine {
                seen.push((t.clone(), a, n, e, s));
            }
            if o.ok {
                assert!(genuine, "paid on a forged signature");
                assert!(accepted.iter().all(|x| x.3 != n), "nonce paid twice");
                assert!(now < e, "paid on an expired approval");
                assert_eq!(out, a);
                assert!(a <= 5 * NEAR);
                accepted.push((now / HOUR_NS, a, !["alice.testnet", "bob.testnet"].contains(&t.as_str()), n));
            } else {
                assert_eq!(out, 0, "a refusal moved funds");
            }
            let paid: u128 = accepted.iter().map(|x| x.1).sum();
            assert_eq!(out_total, paid, "conservation");
            assert_eq!(v.get_stats().total_spent, paid);
        }
        for &(h, _, _, _) in &accepted {
            let w = accepted.iter().filter(|x| x.0 >= h && x.0 < h + WINDOW_HOURS);
            let (t, nv) = w.fold((0u128, 0u128), |(t, nv), x| (t + x.1, nv + if x.2 { x.1 } else { 0 }));
            assert!(t <= 20 * NEAR, "daily cap exceeded in a 24-hour window");
            assert!(nv <= 2 * NEAR, "novel budget exceeded in a 24-hour window");
        }
        assert!(!accepted.is_empty(), "the walk should pay something (seed {seed})");
    }
}

/// The arena's TypeScript model (src/vault/model.ts) wrote these outcomes; the real contract must agree on every step.
#[test]
fn differential_vectors_match_ts_model() {
    use near_sdk::base64::Engine;
    use near_sdk::serde_json::Value;
    let doc: Value = near_sdk::serde_json::from_str(include_str!("../vectors/differential.json")).unwrap();
    let mut v = vault();
    let steps = doc["steps"].as_array().unwrap();
    assert!(steps.len() >= 200);
    let n = |x: &Value| x.as_str().unwrap().parse::<u128>().unwrap();
    for (i, s) in steps.iter().enumerate() {
        ctx(s["caller"].as_str().unwrap(), n(&s["now"]) as u64, 0);
        let sig = near_sdk::base64::engine::general_purpose::STANDARD.decode(s["sig"].as_str().unwrap()).unwrap();
        let o = v.spend(acc(s["receiver"].as_str().unwrap()), n(&s["amount"]), n(&s["nonce"]) as u64, n(&s["expires_at"]) as u64, sig);
        assert_eq!(o.reason.as_deref(), s["expect"].as_str(), "step {i}: {s}");
        assert_eq!(sent(), if o.ok { n(&s["amount"]) } else { 0 });
    }
}
