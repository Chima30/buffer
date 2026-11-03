use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

const USDC: u128 = 1_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn token() -> AccountId {
    acct("usdc.testnet")
}
fn owner() -> AccountId {
    acct("owner.testnet")
}
fn agent() -> AccountId {
    acct("agent.testnet")
}
fn vendor() -> AccountId {
    acct("vendor.testnet")
}
fn contract_id() -> AccountId {
    acct("desk.testnet")
}

fn ctx(predecessor: AccountId) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor)
        .block_timestamp(1_000)
        .attached_deposit(NearToken::from_yoctonear(0));
    b
}

/// Demo setup: 20 USDC product, 13 USDC expense cap, approval above 10 USDC.
fn setup() -> Contract {
    testing_env!(ctx(owner()).build());
    let mut c = Contract::new(owner(), agent(), token(), acct("payout.testnet"), acct("contrib.testnet"), 3000, U128(10 * USDC), 3_600_000_000_000);
    c.set_product("weekly-market-brief".into(), U128(20 * USDC), U128(13 * USDC), true);
    c.set_vendor(vendor(), true);
    c
}

fn pay(c: &mut Contract, order: &str, amount: u128) -> U128 {
    testing_env!(ctx(token()).build());
    match c.ft_on_transfer(acct("customer.testnet"), U128(amount), format!(r#"{{"order_id":"{order}","sku":"weekly-market-brief"}}"#)) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn as_agent<T>(f: impl FnOnce() -> T) -> T {
    testing_env!(ctx(agent()).build());
    f()
}
fn as_owner<T>(f: impl FnOnce() -> T) -> T {
    testing_env!(ctx(owner()).build());
    f()
}

fn resolve_leg(c: &mut Contract, order: &str, leg: u32, ok: bool) {
    // #[callback_result] arguments are plain parameters when called directly in unit tests.
    testing_env!(ctx(contract_id()).build());
    c.on_leg_resolved(order.into(), leg, if ok { Ok(()) } else { Err(PromiseError::Failed) });
}

fn resolve_purchase(c: &mut Contract, order: &str, idx: u32, ok: bool) {
    testing_env!(ctx(contract_id()).build());
    c.on_purchase_resolved(order.into(), idx, if ok { Ok(()) } else { Err(PromiseError::Failed) });
}

fn inference(amount: u128) -> Vec<ExpenseClaim> {
    vec![ExpenseClaim { category: ExpenseCategory::Inference, amount: U128(amount), evidence_ref: "chat:abc".into() }]
}

/// Paid order with a confirmed, owner-approved 12 USDC vendor purchase.
fn paid_with_purchase(c: &mut Contract) {
    pay(c, "o-1", 20 * USDC);
    let r = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Value(0)));
    let _ = as_owner(|| c.approve_purchase("o-1".into(), 0));
    resolve_purchase(c, "o-1", 0, true);
}

// ---------- settlement math ----------

#[test]
fn split_matches_demo_numbers() {
    // gross 20, vendor 12, inference 0.4, cap 13 -> expenses 12.4, net 7.6
    let s = compute_split(20 * USDC, 13 * USDC, 3000, 12 * USDC, 400_000);
    assert_eq!(s.expenses, 12_400_000);
    assert_eq!(s.distributable, 7_600_000);
    assert_eq!(s.contributor, 2_280_000);
    assert_eq!(s.owner, 5_320_000);
    assert_eq!(s.reimb_owner, 400_000);
}

#[test]
fn split_caps_inference_reimbursement() {
    let s = compute_split(20 * USDC, 13 * USDC, 3000, 12 * USDC, 5 * USDC);
    assert_eq!(s.expenses, 13 * USDC);
    assert_eq!(s.reimb_owner, USDC);
    assert_eq!(s.vendor_paid + s.reimb_owner + s.owner + s.contributor, 20 * USDC);
}

#[test]
fn split_invariant_holds_for_many_inputs() {
    let mut seed: u64 = 7;
    let mut next = |m: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % m
    };
    for _ in 0..5000 {
        let gross = 1 + next(100_000_000) as u128;
        let cap = (next(100_000_000) as u128).min(gross);
        let vendor_paid = if cap == 0 { 0 } else { next(cap as u64 + 1) as u128 };
        let s = compute_split(gross, cap, next(10_001) as u16, vendor_paid, next(50_000_000) as u128);
        assert_eq!(s.vendor_paid + s.reimb_owner + s.owner + s.contributor, gross);
        assert!(s.expenses <= cap);
    }
}

// ---------- payments ----------

#[test]
fn accepts_exact_payment_and_rejects_everything_else() {
    let mut c = setup();
    assert_eq!(pay(&mut c, "o-1", 20 * USDC), U128(0));
    assert_eq!(c.get_order("o-1".into()).unwrap().state, OrderState::Paid);
    assert_eq!(pay(&mut c, "o-1", 20 * USDC), U128(20 * USDC)); // duplicate order
    assert_eq!(pay(&mut c, "o-2", 19 * USDC), U128(19 * USDC)); // underpaid
    assert_eq!(pay(&mut c, "o-3", 21 * USDC), U128(21 * USDC)); // overpaid
    assert!(c.get_order("o-2".into()).is_none());
    assert!(get_logs().iter().any(|l| l.contains("payment_rejected")));
}

#[test]
fn rejects_payment_while_paused_and_bad_messages() {
    let mut c = setup();
    as_owner(|| c.pause());
    assert_eq!(pay(&mut c, "o-1", 20 * USDC), U128(20 * USDC));
    as_owner(|| c.unpause());
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(acct("customer.testnet"), U128(20 * USDC), "not json".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(v)) if v == 20 * USDC));
}

#[test]
#[should_panic(expected = "only the configured token can pay")]
fn rejects_other_tokens() {
    let mut c = setup();
    testing_env!(ctx(acct("usdc.fakes.testnet")).build());
    let _ = c.ft_on_transfer(acct("customer.testnet"), U128(20 * USDC), r#"{"order_id":"o-1","sku":"weekly-market-brief"}"#.into());
}

// ---------- procurement ----------

#[test]
fn small_purchase_pays_immediately() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let r = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(5 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(c.get_order("o-1".into()).unwrap().purchases[0].status, PurchaseStatus::Sending);
    resolve_purchase(&mut c, "o-1", 0, true);
    assert_eq!(c.get_order("o-1".into()).unwrap().purchases[0].status, PurchaseStatus::Paid);
}

#[test]
fn large_purchase_waits_for_owner_approval() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let r = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Value(0)));
    assert_eq!(c.get_order("o-1".into()).unwrap().purchases[0].status, PurchaseStatus::AwaitingApproval);
    let _ = as_owner(|| c.approve_purchase("o-1".into(), 0));
    assert_eq!(c.get_order("o-1".into()).unwrap().purchases[0].status, PurchaseStatus::Sending);
}

#[test]
#[should_panic(expected = "vendor is not approved")]
fn unapproved_vendor_is_blocked() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), acct("attacker.testnet"), U128(USDC), "x".into()));
}

#[test]
#[should_panic(expected = "purchase exceeds the order's expense cap")]
fn purchases_cannot_exceed_expense_cap() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(8 * USDC), "a".into()));
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(6 * USDC), "b".into()));
}

#[test]
fn failed_and_rejected_purchases_free_the_cap() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(9 * USDC), "a".into()));
    resolve_purchase(&mut c, "o-1", 0, false);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "b".into()));
    as_owner(|| c.reject_purchase("o-1".into(), 1));
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(9 * USDC), "c".into()));
    let o = c.get_order("o-1".into()).unwrap();
    let statuses: Vec<_> = o.purchases.iter().map(|p| p.status).collect();
    assert_eq!(statuses, vec![PurchaseStatus::Failed, PurchaseStatus::Rejected, PurchaseStatus::Sending]);
}

#[test]
#[should_panic(expected = "agent only")]
fn owner_cannot_request_purchases_as_agent() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_owner(|| c.request_purchase("o-1".into(), vendor(), U128(USDC), "x".into()));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_approve_its_own_purchase() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "x".into()));
    let _ = as_agent(|| c.approve_purchase("o-1".into(), 0));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_add_vendors() {
    let mut c = setup();
    as_agent(|| c.set_vendor(acct("attacker.testnet"), true));
}

#[test]
#[should_panic(expected = "vendor is no longer approved")]
fn approval_fails_if_vendor_was_removed() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "x".into()));
    as_owner(|| c.set_vendor(vendor(), false));
    let _ = as_owner(|| c.approve_purchase("o-1".into(), 0));
}

#[test]
#[should_panic(expected = "a purchase is still open")]
fn cannot_fulfil_with_open_purchase() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "x".into()));
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
}

// ---------- settlement ----------

#[test]
fn full_settlement_lifecycle() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let _ = as_agent(|| c.settle("o-1".into(), inference(400_000)));
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.state, OrderState::Settling);
    let legs: Vec<(LegKind, u128)> = o.legs.iter().map(|l| (l.kind, l.amount.0)).collect();
    assert_eq!(legs, vec![(LegKind::Owner, 5_320_000), (LegKind::Contributor, 2_280_000), (LegKind::ReimbOwner, 400_000)]);
    for i in 0..3 {
        resolve_leg(&mut c, "o-1", i, true);
    }
    assert_eq!(c.get_order("o-1".into()).unwrap().state, OrderState::Settled);
}

#[test]
#[should_panic(expected = "only inference claims")]
fn settle_rejects_supplier_claims() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let claims = vec![ExpenseClaim { category: ExpenseCategory::Supplier, amount: U128(USDC), evidence_ref: "x".into() }];
    let _ = as_agent(|| c.settle("o-1".into(), claims));
}

#[test]
#[should_panic(expected = "order is not in Fulfilled state")]
fn cannot_settle_twice() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let _ = as_agent(|| c.settle("o-1".into(), inference(400_000)));
    let _ = as_agent(|| c.settle("o-1".into(), inference(400_000)));
}

#[test]
#[should_panic(expected = "order is not in Fulfilled state")]
fn cannot_settle_before_fulfilment() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| c.settle("o-1".into(), inference(1)));
}

#[test]
fn failed_leg_can_be_retried_alone() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let _ = as_agent(|| c.settle("o-1".into(), inference(400_000)));
    resolve_leg(&mut c, "o-1", 0, true);
    resolve_leg(&mut c, "o-1", 1, false);
    resolve_leg(&mut c, "o-1", 2, true);
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.state, OrderState::Settling);
    assert_eq!(o.legs[1].status, LegStatus::Failed);
    let _ = as_agent(|| c.retry_leg("o-1".into(), 1));
    assert_eq!(c.get_order("o-1".into()).unwrap().legs[1].attempts, 2);
    resolve_leg(&mut c, "o-1", 1, true);
    assert_eq!(c.get_order("o-1".into()).unwrap().state, OrderState::Settled);
}

#[test]
#[should_panic(expected = "leg is not failed")]
fn cannot_retry_confirmed_leg() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let _ = as_agent(|| c.settle("o-1".into(), inference(400_000)));
    resolve_leg(&mut c, "o-1", 0, true);
    let _ = as_agent(|| c.retry_leg("o-1".into(), 0));
}

// ---------- refunds ----------

#[test]
fn refund_without_purchases_returns_full_gross() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_owner(|| c.refund("o-1".into()));
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.legs[0].amount, U128(20 * USDC));
    assert_eq!(o.legs[0].recipient, acct("customer.testnet"));
    resolve_leg(&mut c, "o-1", 0, true);
    assert_eq!(c.get_order("o-1".into()).unwrap().state, OrderState::Refunded);
}

#[test]
fn refund_after_vendor_spend_needs_owner_top_up_to_be_whole() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    // Owner tops up the 12 USDC spent on the vendor.
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(owner(), U128(12 * USDC), r#"{"refund_top_up":"o-1"}"#.into());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    let _ = as_owner(|| c.refund("o-1".into()));
    assert_eq!(c.get_order("o-1".into()).unwrap().legs[0].amount, U128(20 * USDC));
}

#[test]
fn refund_without_top_up_returns_what_escrow_holds() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    let _ = as_owner(|| c.refund("o-1".into()));
    assert_eq!(c.get_order("o-1".into()).unwrap().legs[0].amount, U128(8 * USDC));
    assert!(get_logs().iter().any(|l| l.contains("refund_started") && l.contains("\"shortfall\":\"12000000\"")));
}

#[test]
fn only_owner_can_top_up() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(acct("stranger.testnet"), U128(USDC), r#"{"refund_top_up":"o-1"}"#.into());
    assert!(matches!(r, PromiseOrValue::Value(U128(v)) if v == USDC));
}

#[test]
fn anyone_can_refund_after_deadline_only() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let mut late = ctx(acct("stranger.testnet"));
    late.block_timestamp(1_000 + 3_600_000_000_001);
    testing_env!(late.build());
    let _ = c.refund("o-1".into());
    assert_eq!(c.get_order("o-1".into()).unwrap().state, OrderState::Refunding);
}

#[test]
#[should_panic(expected = "refund not permitted")]
fn stranger_cannot_refund_before_deadline() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    testing_env!(ctx(acct("stranger.testnet")).build());
    let _ = c.refund("o-1".into());
}

// ---------- owner-only controls ----------

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_change_split() {
    let mut c = setup();
    as_agent(|| c.set_recipients(acct("payout.testnet"), acct("evil.testnet"), 9000));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_change_approval_threshold() {
    let mut c = setup();
    as_agent(|| c.set_purchase_approval_above(U128(1_000 * USDC)));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_change_policy_hash() {
    let mut c = setup();
    as_agent(|| c.set_policy_hash(1, "a".repeat(64)));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_unpause() {
    let mut c = setup();
    as_owner(|| c.pause());
    as_agent(|| c.unpause());
}

#[test]
#[should_panic(expected = "agent cannot be a revenue recipient")]
fn agent_cannot_be_contributor() {
    let mut c = setup();
    as_owner(|| c.set_recipients(acct("payout.testnet"), agent(), 3000));
}

#[test]
#[should_panic(expected = "paused")]
fn paused_blocks_purchases() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    as_owner(|| c.pause());
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(USDC), "x".into()));
}

#[test]
fn policy_hash_versions_must_increase() {
    let mut c = setup();
    as_owner(|| c.set_policy_hash(1, "a".repeat(64)));
    assert_eq!(c.get_config().policy_version, 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        as_owner(|| c.set_policy_hash(1, "b".repeat(64)));
    }));
    assert!(r.is_err());
}
