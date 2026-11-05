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
    let mut c = Contract::new(
        owner(),
        agent(),
        token(),
        acct("payout.testnet"),
        acct("contrib.testnet"),
        3000,
        U128(10 * USDC),
        3_600_000_000_000,
    );
    c.set_product(
        "weekly-market-brief".into(),
        U128(20 * USDC),
        U128(13 * USDC),
        true,
    );
    c.set_vendor(vendor(), true);
    c
}

fn pay(c: &mut Contract, order: &str, amount: u128) -> U128 {
    testing_env!(ctx(token()).build());
    match c.ft_on_transfer(
        acct("customer.testnet"),
        U128(amount),
        format!(r#"{{"order_id":"{order}","sku":"weekly-market-brief"}}"#),
    ) {
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
    c.on_leg_resolved(
        order.into(),
        leg,
        if ok {
            Ok(())
        } else {
            Err(PromiseError::Failed)
        },
    );
}

fn resolve_purchase(c: &mut Contract, order: &str, idx: u32, ok: bool) {
    testing_env!(ctx(contract_id()).build());
    c.on_purchase_resolved(
        order.into(),
        idx,
        if ok {
            Ok(())
        } else {
            Err(PromiseError::Failed)
        },
    );
}

fn inference(amount: u128) -> Vec<ExpenseClaim> {
    vec![ExpenseClaim {
        category: ExpenseCategory::Inference,
        amount: U128(amount),
        evidence_ref: "chat:abc".into(),
    }]
}

/// Paid order with a confirmed, owner-approved 12 USDC vendor purchase.
fn paid_with_purchase(c: &mut Contract) {
    pay(c, "o-1", 20 * USDC);
    let r =
        as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "dataset".into()));
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
    assert_eq!(
        s.vendor_paid + s.reimb_owner + s.owner + s.contributor,
        20 * USDC
    );
}

#[test]
fn split_invariant_holds_for_many_inputs() {
    let mut seed: u64 = 7;
    let mut next = |m: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % m
    };
    for _ in 0..5000 {
        let gross = 1 + next(100_000_000) as u128;
        let cap = (next(100_000_000) as u128).min(gross);
        let vendor_paid = if cap == 0 {
            0
        } else {
            next(cap as u64 + 1) as u128
        };
        let s = compute_split(
            gross,
            cap,
            next(10_001) as u16,
            vendor_paid,
            next(50_000_000) as u128,
        );
        assert_eq!(
            s.vendor_paid + s.reimb_owner + s.owner + s.contributor,
            gross
        );
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
    let _ = c.ft_on_transfer(
        acct("customer.testnet"),
        U128(20 * USDC),
        r#"{"order_id":"o-1","sku":"weekly-market-brief"}"#.into(),
    );
}

// ---------- procurement ----------

#[test]
fn small_purchase_pays_immediately() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let r =
        as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(5 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(
        c.get_order("o-1".into()).unwrap().purchases[0].status,
        PurchaseStatus::Sending
    );
    resolve_purchase(&mut c, "o-1", 0, true);
    assert_eq!(
        c.get_order("o-1".into()).unwrap().purchases[0].status,
        PurchaseStatus::Paid
    );
}

#[test]
fn large_purchase_waits_for_owner_approval() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let r =
        as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(12 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Value(0)));
    assert_eq!(
        c.get_order("o-1".into()).unwrap().purchases[0].status,
        PurchaseStatus::AwaitingApproval
    );
    let _ = as_owner(|| c.approve_purchase("o-1".into(), 0));
    assert_eq!(
        c.get_order("o-1".into()).unwrap().purchases[0].status,
        PurchaseStatus::Sending
    );
}

#[test]
#[should_panic(expected = "vendor is not approved")]
fn unapproved_vendor_is_blocked() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    let _ = as_agent(|| {
        c.request_purchase(
            "o-1".into(),
            acct("attacker.testnet"),
            U128(USDC),
            "x".into(),
        )
    });
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
    assert_eq!(
        statuses,
        vec![
            PurchaseStatus::Failed,
            PurchaseStatus::Rejected,
            PurchaseStatus::Sending
        ]
    );
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
    as_agent(|| c.settle("o-1".into(), inference(400_000)));
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.state, OrderState::Settling);
    let legs: Vec<(LegKind, u128)> = o.legs.iter().map(|l| (l.kind, l.amount.0)).collect();
    assert_eq!(
        legs,
        vec![
            (LegKind::Owner, 5_320_000),
            (LegKind::Contributor, 2_280_000),
            (LegKind::ReimbOwner, 400_000)
        ]
    );
    for i in 0..3 {
        resolve_leg(&mut c, "o-1", i, true);
    }
    assert_eq!(
        c.get_order("o-1".into()).unwrap().state,
        OrderState::Settled
    );
}

#[test]
#[should_panic(expected = "only inference claims")]
fn settle_rejects_supplier_claims() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    let claims = vec![ExpenseClaim {
        category: ExpenseCategory::Supplier,
        amount: U128(USDC),
        evidence_ref: "x".into(),
    }];
    as_agent(|| c.settle("o-1".into(), claims));
}

#[test]
#[should_panic(expected = "order is not in Fulfilled state")]
fn cannot_settle_twice() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    as_agent(|| c.settle("o-1".into(), inference(400_000)));
    as_agent(|| c.settle("o-1".into(), inference(400_000)));
}

#[test]
#[should_panic(expected = "order is not in Fulfilled state")]
fn cannot_settle_before_fulfilment() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    as_agent(|| c.settle("o-1".into(), inference(1)));
}

#[test]
fn failed_leg_can_be_retried_alone() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    as_agent(|| c.settle("o-1".into(), inference(400_000)));
    resolve_leg(&mut c, "o-1", 0, true);
    resolve_leg(&mut c, "o-1", 1, false);
    resolve_leg(&mut c, "o-1", 2, true);
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.state, OrderState::Settling);
    assert_eq!(o.legs[1].status, LegStatus::Failed);
    let _ = as_agent(|| c.retry_leg("o-1".into(), 1));
    assert_eq!(c.get_order("o-1".into()).unwrap().legs[1].attempts, 2);
    resolve_leg(&mut c, "o-1", 1, true);
    assert_eq!(
        c.get_order("o-1".into()).unwrap().state,
        OrderState::Settled
    );
}

#[test]
#[should_panic(expected = "leg is not failed")]
fn cannot_retry_confirmed_leg() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    as_agent(|| c.mark_fulfilled("o-1".into(), "a".repeat(64)));
    as_agent(|| c.settle("o-1".into(), inference(400_000)));
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
    assert_eq!(
        c.get_order("o-1".into()).unwrap().state,
        OrderState::Refunded
    );
}

#[test]
fn refund_after_vendor_spend_needs_owner_top_up_to_be_whole() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    // Owner tops up the 12 USDC spent on the vendor.
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(
        owner(),
        U128(12 * USDC),
        r#"{"refund_top_up":"o-1"}"#.into(),
    );
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    let _ = as_owner(|| c.refund("o-1".into()));
    assert_eq!(
        c.get_order("o-1".into()).unwrap().legs[0].amount,
        U128(20 * USDC)
    );
}

#[test]
fn refund_without_top_up_returns_what_escrow_holds() {
    let mut c = setup();
    paid_with_purchase(&mut c);
    let _ = as_owner(|| c.refund("o-1".into()));
    assert_eq!(
        c.get_order("o-1".into()).unwrap().legs[0].amount,
        U128(8 * USDC)
    );
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("refund_started") && l.contains("\"shortfall\":\"12000000\""))
    );
}

#[test]
fn only_owner_can_top_up() {
    let mut c = setup();
    pay(&mut c, "o-1", 20 * USDC);
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(
        acct("stranger.testnet"),
        U128(USDC),
        r#"{"refund_top_up":"o-1"}"#.into(),
    );
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
    assert_eq!(
        c.get_order("o-1".into()).unwrap().state,
        OrderState::Refunding
    );
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

// ---------- cross-chain purchases (Chain Signatures) ----------

const EVM_VENDOR: &str = "0x00000000000000000000000000000000000000aa";
const ATTACKER_EVM: &str = "0x00000000000000000000000000000000000000ee";
const GWEI: u128 = 1_000_000_000;

fn evm_setup() -> Contract {
    let mut c = setup();
    as_owner(|| {
        c.set_evm_config(EvmConfig {
            mpc_contract: acct("v1.signer-prod.testnet"),
            chain_id: 11155111,
            usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into(),
            max_fee_per_gas_cap: U128(100 * GWEI),
            gas_limit: 100_000,
        });
        c.set_evm_vendor(EVM_VENDOR.to_uppercase().replace("0X", "0x"), true);
    });
    pay(&mut c, "o-1", 20 * USDC);
    c
}

fn evm_request(c: &mut Contract, vendor: &str, amount: u128, fee: u128) -> PromiseOrValue<u32> {
    as_agent(|| {
        c.request_evm_purchase(
            "o-1".into(),
            vendor.into(),
            U128(amount),
            U128(fee),
            U128(GWEI),
        )
    })
}

fn mpc_reply(c: &mut Contract, idx: u32, ok: bool) {
    testing_env!(ctx(contract_id()).build());
    let v = serde_json::json!({ "scheme": "Secp256k1", "big_r": { "affine_point": format!("02{}", "11".repeat(32)) }, "s": { "scalar": "22".repeat(32) }, "recovery_id": 1 });
    c.on_evm_signed(
        "o-1".into(),
        idx,
        if ok { Ok(v) } else { Err(PromiseError::Failed) },
    );
}

#[test]
fn small_evm_purchase_is_built_and_sent_for_signing() {
    let mut c = evm_setup();
    assert!(matches!(
        evm_request(&mut c, EVM_VENDOR, 5 * USDC, 30 * GWEI),
        PromiseOrValue::Promise(_)
    ));
    let p = &c.get_evm_purchases("o-1".into())[0];
    assert_eq!(p.status, EvmPurchaseStatus::Signing);
    assert_eq!(p.nonce, Some(0));
    assert_eq!(c.get_evm_nonce(), 1);
    // The hash the MPC signs is keccak256 of the transaction the contract built.
    let tx = c.get_evm_unsigned_tx("o-1".into(), 0).unwrap();
    let bytes: Vec<u8> = (0..tx.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&tx[i..i + 2], 16).unwrap())
        .collect();
    assert_eq!(
        p.payload_hash.clone().unwrap(),
        evm::to_hex(&env::keccak256(&bytes))
    );
    assert!(
        tx.contains("a9059cbb00000000000000000000000000000000000000000000000000000000000000aa")
    );
    mpc_reply(&mut c, 0, true);
    let p = &c.get_evm_purchases("o-1".into())[0];
    assert_eq!(p.status, EvmPurchaseStatus::Signed);
    assert_eq!(p.signature.as_ref().unwrap().recovery_id, 1);
}

#[test]
#[should_panic(expected = "evm vendor is not approved")]
fn evm_attacker_address_is_refused() {
    let mut c = evm_setup();
    let _ = evm_request(&mut c, ATTACKER_EVM, 5 * USDC, 30 * GWEI);
}

#[test]
#[should_panic(expected = "max_fee_per_gas above the owner's cap")]
fn evm_gas_fee_is_capped() {
    let mut c = evm_setup();
    let _ = evm_request(&mut c, EVM_VENDOR, 5 * USDC, 101 * GWEI);
}

#[test]
#[should_panic(expected = "agent only")]
fn owner_path_cannot_be_used_by_strangers_to_request() {
    let mut c = evm_setup();
    testing_env!(ctx(acct("mallory.testnet")).build());
    let _ = c.request_evm_purchase(
        "o-1".into(),
        EVM_VENDOR.into(),
        U128(USDC),
        U128(GWEI),
        U128(GWEI),
    );
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_approve_evm_vendors() {
    let mut c = evm_setup();
    as_agent(|| c.set_evm_vendor(ATTACKER_EVM.into(), true));
}

#[test]
fn large_evm_purchase_waits_for_the_owner_and_nonce_is_assigned_on_approval() {
    let mut c = evm_setup();
    assert!(matches!(
        evm_request(&mut c, EVM_VENDOR, 12 * USDC, 30 * GWEI),
        PromiseOrValue::Value(0)
    ));
    let p = &c.get_evm_purchases("o-1".into())[0];
    assert_eq!(
        (p.status.clone(), p.nonce),
        (EvmPurchaseStatus::AwaitingApproval, None)
    );
    assert_eq!(c.get_evm_nonce(), 0);
    let _ = as_owner(|| c.approve_evm_purchase("o-1".into(), 0));
    assert_eq!(c.get_evm_purchases("o-1".into())[0].nonce, Some(0));
}

#[test]
#[should_panic(expected = "purchase exceeds the order's expense cap")]
fn near_and_evm_purchases_share_the_cap() {
    let mut c = evm_setup();
    let _ = as_agent(|| c.request_purchase("o-1".into(), vendor(), U128(8 * USDC), "a".into()));
    let _ = evm_request(&mut c, EVM_VENDOR, 6 * USDC, 30 * GWEI); // 8 + 6 > 13
}

#[test]
fn failed_signature_returns_the_nonce_and_frees_the_cap() {
    let mut c = evm_setup();
    let _ = evm_request(&mut c, EVM_VENDOR, 5 * USDC, 30 * GWEI);
    mpc_reply(&mut c, 0, false);
    assert_eq!(
        c.get_evm_purchases("o-1".into())[0].status,
        EvmPurchaseStatus::Failed
    );
    assert_eq!(c.get_evm_nonce(), 0);
    let _ = evm_request(&mut c, EVM_VENDOR, 10 * USDC, 30 * GWEI);
    assert_eq!(c.get_evm_purchases("o-1".into())[1].nonce, Some(0));
}

#[test]
#[should_panic(expected = "a cross-chain purchase is still open")]
fn cannot_fulfil_while_signing() {
    let mut c = evm_setup();
    let _ = evm_request(&mut c, EVM_VENDOR, 5 * USDC, 30 * GWEI);
    as_agent(|| c.mark_fulfilled("o-1".into(), "ab".repeat(32)));
}

#[test]
fn settlement_reimburses_the_owner_for_signed_evm_purchases() {
    let mut c = evm_setup();
    let _ = evm_request(&mut c, EVM_VENDOR, 5 * USDC, 30 * GWEI);
    mpc_reply(&mut c, 0, true);
    as_agent(|| c.mark_fulfilled("o-1".into(), "ab".repeat(32)));
    as_agent(|| c.settle("o-1".into(), inference(1_000)));
    let o = c.get_order("o-1".into()).unwrap();
    let amt = |k: LegKind| {
        o.legs
            .iter()
            .find(|l| l.kind == k)
            .map(|l| l.amount.0)
            .unwrap_or(0)
    };
    // E = 5 + 0.001 = 5.001; D = 14.999; C = 4.4997; O = 10.4993; reimb = 5.001
    assert_eq!(amt(LegKind::ReimbOwner), 5_001_000);
    assert_eq!(amt(LegKind::Contributor), 4_499_700);
    assert_eq!(amt(LegKind::Owner), 10_499_300);
    assert_eq!(
        amt(LegKind::ReimbOwner) + amt(LegKind::Contributor) + amt(LegKind::Owner),
        20 * USDC
    );
}

#[test]
fn migrate_keeps_existing_state() {
    let mut c = evm_setup(); // pays o-1 and configures Ethereum
    let _ = evm_request(&mut c, EVM_VENDOR, 5 * USDC, 30 * GWEI);
    as_owner(|| {
        c.set_product(
            "brief-subscription".into(),
            U128(10 * USDC),
            U128(2 * USDC),
            true,
        );
        c.set_subscription_plan("brief-subscription".into(), 3_600_000_000_000, 2, 8, true);
    });
    testing_env!(ctx(token()).build());
    let _ = c.ft_on_transfer(
        acct("customer.testnet"),
        U128(20 * USDC),
        r#"{"subscription_id":"s-1","sku":"brief-subscription","issues":2}"#.into(),
    );
    c.subscription_plans.flush();
    c.subscriptions.flush();
    c.products.flush();
    c.vendors.flush();
    c.orders.flush();
    c.evm_vendors.flush();
    c.evm_purchases.flush();
    let treasury = Treasury {
        reserve_bps: 1000,
        reserve_balance: U128(7),
        ..Treasury::default()
    };
    // Rebuild the pre-quotes layout from the same collections, write it, then migrate.
    let Contract {
        owner,
        agent,
        token_id,
        owner_payout,
        contributor,
        contributor_bps,
        purchase_approval_above,
        order_ttl_ns,
        paused,
        products,
        vendors,
        orders,
        evm,
        evm_vendors,
        evm_purchases,
        evm_nonce,
        subscription_plans,
        subscriptions,
        ..
    } = c;
    let v4 = ContractV4 {
        owner,
        agent,
        token_id,
        owner_payout,
        contributor,
        contributor_bps,
        purchase_approval_above,
        order_ttl_ns,
        paused,
        policy_version: 3,
        policy_hash: Some("ab".repeat(32)),
        products,
        vendors,
        orders,
        evm,
        evm_vendors,
        evm_purchases,
        evm_nonce,
        treasury: treasury.clone(),
        subscription_plans,
        subscriptions,
    };
    env::state_write(&v4);
    testing_env!(ctx(contract_id()).build());
    let m = Contract::migrate();
    assert_eq!(m.get_config().policy_version, 3);
    assert_eq!(m.get_order("o-1".into()).unwrap().state, OrderState::Paid);
    assert_eq!(m.get_products().len(), 2);
    assert!(m.get_evm_config().is_some());
    assert_eq!(m.get_evm_vendors().len(), 1);
    assert_eq!(m.get_evm_purchases("o-1".into()).len(), 1);
    assert_eq!(m.get_evm_nonce(), 1);
    assert_eq!(m.get_treasury(), treasury);
    assert_eq!(m.get_subscription_plans().len(), 1);
    assert_eq!(
        m.get_subscription("s-1".into()).unwrap().escrow.0,
        20 * USDC
    );
    assert!(m.get_quote_rules().is_empty());
    assert!(m.get_quote("q-1".into()).is_none());
}

// ---------- self-funding treasury ----------

const NEAR: u128 = 10u128.pow(24);

fn with_reserve(c: &mut Contract, bps: u16, target: u128) {
    as_owner(|| c.set_treasury_rules(bps, U128(target), U128(NEAR / 2), U128(2 * NEAR)));
}

fn settle_plain(c: &mut Contract, order: &str) {
    pay(c, order, 20 * USDC);
    as_agent(|| c.mark_fulfilled(order.into(), "ab".repeat(32)));
    as_agent(|| c.settle(order.into(), inference(400_000)));
}

fn leg(c: &Contract, order: &str, k: LegKind) -> u128 {
    c.get_order(order.into())
        .unwrap()
        .legs
        .iter()
        .find(|l| l.kind == k)
        .map(|l| l.amount.0)
        .unwrap_or(0)
}

#[test]
fn reserve_comes_out_of_the_owner_share_only() {
    let mut c = setup();
    with_reserve(&mut c, 1000, 20 * USDC);
    settle_plain(&mut c, "o-1");
    // gross 20, inference 0.4: net 19.6, contributor 5.88, owner 13.72 -> reserve 1.372
    assert_eq!(leg(&c, "o-1", LegKind::Contributor), 5_880_000);
    assert_eq!(leg(&c, "o-1", LegKind::Reserve), 1_372_000);
    assert_eq!(leg(&c, "o-1", LegKind::Owner), 12_348_000);
    let o = c.get_order("o-1".into()).unwrap();
    assert_eq!(o.legs.iter().map(|l| l.amount.0).sum::<u128>(), 20 * USDC);
    assert_eq!(c.get_treasury().reserve_balance, U128(1_372_000));
    // The reserve leg is never sent, so it is already confirmed.
    assert_eq!(
        o.legs
            .iter()
            .find(|l| l.kind == LegKind::Reserve)
            .unwrap()
            .status,
        LegStatus::Confirmed
    );
}

#[test]
fn reserve_stops_at_its_target() {
    let mut c = setup();
    with_reserve(&mut c, 5000, 8 * USDC);
    settle_plain(&mut c, "o-1"); // wants 6.86, keeps 6.86
    settle_plain(&mut c, "o-2"); // wants 6.86, room 1.14
    assert_eq!(leg(&c, "o-2", LegKind::Reserve), 1_140_000);
    assert_eq!(c.get_treasury().reserve_balance, U128(8 * USDC));
    settle_plain(&mut c, "o-3");
    assert_eq!(leg(&c, "o-3", LegKind::Reserve), 0);
}

#[test]
fn no_rules_means_no_reserve() {
    let mut c = setup();
    settle_plain(&mut c, "o-1");
    assert_eq!(leg(&c, "o-1", LegKind::Reserve), 0);
    assert_eq!(leg(&c, "o-1", LegKind::Owner), 13_720_000);
}

#[test]
fn refunds_use_the_reserve_before_asking_the_owner() {
    let mut c = setup();
    with_reserve(&mut c, 10000, 20 * USDC);
    settle_plain(&mut c, "o-1"); // reserve keeps the whole owner share: 13.72
    paid_with_purchase_on(&mut c, "o-2"); // 12 USDC left escrow for the vendor
    let _ = as_owner(|| c.refund("o-2".into()));
    let o = c.get_order("o-2".into()).unwrap();
    assert_eq!(o.legs[0].amount, U128(20 * USDC));
    assert_eq!(
        c.get_treasury().reserve_balance,
        U128(13_720_000 - 12 * USDC)
    );
}

fn paid_with_purchase_on(c: &mut Contract, order: &str) {
    pay(c, order, 20 * USDC);
    let _ =
        as_agent(|| c.request_purchase(order.into(), vendor(), U128(12 * USDC), "dataset".into()));
    let _ = as_owner(|| c.approve_purchase(order.into(), 0));
    resolve_purchase(c, order, 0, true);
}

#[test]
fn gas_refills_are_capped_per_week() {
    let mut c = setup();
    with_reserve(&mut c, 0, 0);
    testing_env!(
        ctx(owner())
            .attached_deposit(NearToken::from_yoctonear(5 * NEAR))
            .build()
    );
    c.fund_gas_reserve();
    for _ in 0..4 {
        let _ = as_agent(|| c.refill_agent_gas());
    }
    assert_eq!(c.get_treasury().gas_spent_week, U128(2 * NEAR));
    assert_eq!(c.get_treasury().gas_reserve, U128(3 * NEAR));
}

#[test]
#[should_panic(expected = "weekly gas refill cap reached")]
fn gas_refill_beyond_the_cap_is_refused() {
    let mut c = setup();
    with_reserve(&mut c, 0, 0);
    testing_env!(
        ctx(owner())
            .attached_deposit(NearToken::from_yoctonear(5 * NEAR))
            .build()
    );
    c.fund_gas_reserve();
    for _ in 0..5 {
        let _ = as_agent(|| c.refill_agent_gas());
    }
}

#[test]
fn gas_cap_resets_after_a_week() {
    let mut c = setup();
    with_reserve(&mut c, 0, 0);
    testing_env!(
        ctx(owner())
            .attached_deposit(NearToken::from_yoctonear(5 * NEAR))
            .build()
    );
    c.fund_gas_reserve();
    for _ in 0..4 {
        let _ = as_agent(|| c.refill_agent_gas());
    }
    testing_env!(ctx(agent()).block_timestamp(1_000 + WEEK_NS + 1).build());
    let _ = c.refill_agent_gas();
    assert_eq!(c.get_treasury().gas_spent_week, U128(NEAR / 2));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_change_treasury_rules() {
    let mut c = setup();
    as_agent(|| c.set_treasury_rules(10000, U128(u128::MAX), U128(NEAR), U128(NEAR)));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_withdraw_the_reserve() {
    let mut c = setup();
    with_reserve(&mut c, 10000, 20 * USDC);
    settle_plain(&mut c, "o-1");
    let _ = as_agent(|| c.withdraw_reserve(U128(USDC)));
}

#[test]
#[should_panic(expected = "agent only")]
fn strangers_cannot_trigger_gas_refills() {
    let mut c = setup();
    with_reserve(&mut c, 0, 0);
    testing_env!(ctx(acct("mallory.testnet")).build());
    let _ = c.refill_agent_gas();
}

#[test]
fn reserve_cut_math() {
    assert_eq!(reserve_cut(13_720_000, 1000, 20 * USDC, 0), 1_372_000);
    assert_eq!(reserve_cut(13_720_000, 1000, 1_000_000, 500_000), 500_000);
    assert_eq!(reserve_cut(13_720_000, 1000, 1_000_000, 2_000_000), 0);
    assert_eq!(reserve_cut(5, 10000, u128::MAX, 0), 5);
}

// ---------- subscriptions ----------

const HOUR: u64 = 3_600_000_000_000;

fn customer() -> AccountId {
    acct("customer.testnet")
}

/// 10 USDC issues, 2..=8 per subscription, one per hour.
fn sub_setup() -> Contract {
    let mut c = setup();
    as_owner(|| {
        c.set_product(
            "brief-subscription".into(),
            U128(10 * USDC),
            U128(2 * USDC),
            true,
        );
        c.set_subscription_plan("brief-subscription".into(), HOUR, 2, 8, true);
    });
    c
}

fn subscribe(c: &mut Contract, id: &str, issues: u32, amount: u128) -> U128 {
    testing_env!(ctx(token()).build());
    match c.ft_on_transfer(
        customer(),
        U128(amount),
        format!(r#"{{"subscription_id":"{id}","sku":"brief-subscription","issues":{issues}}}"#),
    ) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn at(who: AccountId, ts: u64) {
    let mut b = ctx(who);
    b.block_timestamp(ts);
    testing_env!(b.build());
}

#[test]
fn subscription_prepays_exact_issues() {
    let mut c = sub_setup();
    assert_eq!(subscribe(&mut c, "s-1", 3, 30 * USDC).0, 0);
    let s = c.get_subscription("s-1".into()).unwrap();
    assert_eq!(
        (s.issues_total, s.issues_started, s.escrow.0, s.state),
        (3, 0, 30 * USDC, SubscriptionState::Active)
    );
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("subscription_started"))
    );
}

#[test]
fn subscription_rejects_bad_payments() {
    let mut c = sub_setup();
    assert_eq!(subscribe(&mut c, "s-1", 3, 29 * USDC).0, 29 * USDC); // wrong amount
    assert_eq!(subscribe(&mut c, "s-1", 1, 10 * USDC).0, 10 * USDC); // below min
    assert_eq!(subscribe(&mut c, "s-1", 9, 90 * USDC).0, 90 * USDC); // above max
    assert_eq!(
        subscribe(&mut c, &"s".repeat(61), 2, 20 * USDC).0,
        20 * USDC
    ); // id too long for issue ids
    // A product without a plan cannot be subscribed to.
    testing_env!(ctx(token()).build());
    let r = c.ft_on_transfer(
        customer(),
        U128(40 * USDC),
        r#"{"subscription_id":"s-2","sku":"weekly-market-brief","issues":2}"#.into(),
    );
    assert!(matches!(r, PromiseOrValue::Value(v) if v.0 == 40 * USDC));
    assert!(c.get_subscription("s-1".into()).is_none());
    assert_eq!(subscribe(&mut c, "s-1", 2, 20 * USDC).0, 0);
    assert_eq!(subscribe(&mut c, "s-1", 2, 20 * USDC).0, 20 * USDC); // duplicate
    as_owner(|| c.pause());
    assert_eq!(subscribe(&mut c, "s-3", 2, 20 * USDC).0, 20 * USDC);
}

#[test]
fn issues_open_on_schedule_as_normal_orders() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    at(agent(), 1_000);
    assert_eq!(c.start_issue("s-1".into()), "s-1-1");
    let o = c.get_order("s-1-1".into()).unwrap();
    assert_eq!(
        (o.customer.clone(), o.gross.0, o.state, o.sku.as_str()),
        (
            customer(),
            10 * USDC,
            OrderState::Paid,
            "brief-subscription"
        )
    );
    assert_eq!(
        c.get_subscription("s-1".into()).unwrap().escrow.0,
        10 * USDC
    );
    // The issue settles like any order.
    as_agent(|| c.mark_fulfilled("s-1-1".into(), "ab".repeat(32)));
    as_agent(|| c.settle("s-1-1".into(), inference(500_000)));
    let legs = c.get_order("s-1-1".into()).unwrap().legs;
    assert_eq!(legs.iter().map(|l| l.amount.0).sum::<u128>(), 10 * USDC);
    // Second issue only after the interval.
    at(agent(), 1_000 + HOUR);
    assert_eq!(c.start_issue("s-1".into()), "s-1-2");
    let s = c.get_subscription("s-1".into()).unwrap();
    assert_eq!(
        (s.issues_started, s.escrow.0, s.state),
        (2, 0, SubscriptionState::Completed)
    );
}

#[test]
#[should_panic(expected = "next issue is not due yet")]
fn issue_cannot_open_early() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 3, 30 * USDC);
    at(agent(), 1_000);
    c.start_issue("s-1".into());
    at(agent(), 1_000 + HOUR - 1);
    c.start_issue("s-1".into());
}

#[test]
#[should_panic(expected = "subscription is not active")]
fn completed_subscription_opens_nothing() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    at(agent(), 1_000);
    c.start_issue("s-1".into());
    at(agent(), 1_000 + HOUR);
    c.start_issue("s-1".into());
    at(agent(), 1_000 + 2 * HOUR);
    c.start_issue("s-1".into());
}

#[test]
#[should_panic(expected = "agent only")]
fn only_agent_opens_issues() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    at(customer(), 1_000);
    c.start_issue("s-1".into());
}

#[test]
#[should_panic(expected = "paused")]
fn paused_business_opens_no_issues() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    as_owner(|| c.pause());
    at(agent(), 1_000);
    c.start_issue("s-1".into());
}

#[test]
fn cancel_refunds_exactly_the_unstarted_issues() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 4, 40 * USDC);
    at(agent(), 1_000);
    c.start_issue("s-1".into());
    as_owner(|| c.pause()); // cancelling still works while paused
    at(customer(), 2_000);
    c.cancel_subscription("s-1".into());
    let s = c.get_subscription("s-1".into()).unwrap();
    assert_eq!(s.state, SubscriptionState::Cancelled);
    assert_eq!(s.escrow.0, 0);
    let leg = s.refund.unwrap();
    assert_eq!(
        (leg.recipient, leg.amount.0, leg.status),
        (customer(), 30 * USDC, LegStatus::Pending)
    );
    // The started issue is untouched.
    assert_eq!(c.get_order("s-1-1".into()).unwrap().state, OrderState::Paid);
    testing_env!(ctx(contract_id()).build());
    c.on_subscription_refunded("s-1".into(), Ok(()));
    assert_eq!(
        c.get_subscription("s-1".into())
            .unwrap()
            .refund
            .unwrap()
            .status,
        LegStatus::Confirmed
    );
}

#[test]
fn failed_subscription_refund_can_be_retried() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    as_owner(|| c.cancel_subscription("s-1".into()));
    testing_env!(ctx(contract_id()).build());
    c.on_subscription_refunded("s-1".into(), Err(PromiseError::Failed));
    assert_eq!(
        c.get_subscription("s-1".into())
            .unwrap()
            .refund
            .unwrap()
            .status,
        LegStatus::Failed
    );
    at(customer(), 2_000);
    let _ = c.retry_subscription_refund("s-1".into());
    let leg = c.get_subscription("s-1".into()).unwrap().refund.unwrap();
    assert_eq!((leg.status, leg.attempts), (LegStatus::Pending, 2));
}

#[test]
#[should_panic(expected = "customer or owner only")]
fn strangers_cannot_cancel() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    at(agent(), 1_000);
    c.cancel_subscription("s-1".into());
}

#[test]
#[should_panic(expected = "subscription is not active")]
fn cancelled_subscription_opens_no_issues() {
    let mut c = sub_setup();
    subscribe(&mut c, "s-1", 2, 20 * USDC);
    as_owner(|| c.cancel_subscription("s-1".into()));
    at(agent(), 1_000);
    c.start_issue("s-1".into());
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_sets_plans() {
    let mut c = sub_setup();
    as_agent(|| c.set_subscription_plan("brief-subscription".into(), 1, 1, 52, true));
}

// ---------- quotes ----------

const MIN: u64 = 60_000_000_000;

/// custom-brief quoted between 5 and 50 USDC, expense cap at most 60% of the price, quotes open up to 30 minutes.
fn quote_setup() -> Contract {
    let mut c = setup();
    as_owner(|| {
        c.set_product("custom-brief".into(), U128(5 * USDC), U128(3 * USDC), true);
        c.set_quote_rules(
            "custom-brief".into(),
            U128(5 * USDC),
            U128(50 * USDC),
            6000,
            30 * MIN,
            true,
        );
    });
    c
}

fn quote(c: &mut Contract, id: &str, amount: u128, cap: u128, ttl: u64) {
    at(agent(), 1_000);
    c.create_quote(
        id.into(),
        "custom-brief".into(),
        U128(amount),
        U128(cap),
        1_000 + ttl,
    );
}

fn pay_quote(c: &mut Contract, id: &str, amount: u128, ts: u64) -> u128 {
    let mut b = ctx(token());
    b.block_timestamp(ts);
    testing_env!(b.build());
    match c.ft_on_transfer(
        customer(),
        U128(amount),
        format!(r#"{{"order_id":"{id}","sku":"custom-brief"}}"#),
    ) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

#[test]
fn quoted_order_pays_exactly_the_quote() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 12 * USDC, 7 * USDC, 30 * MIN);
    assert_eq!(pay_quote(&mut c, "q-1", 11 * USDC, 2_000), 11 * USDC); // wrong amount returned
    assert_eq!(pay_quote(&mut c, "q-1", 12 * USDC, 2_000), 0);
    assert_eq!(c.get_order("q-1".into()).unwrap().gross.0, 12 * USDC);
    assert!(c.get_quote("q-1".into()).unwrap().paid);
    assert_eq!(pay_quote(&mut c, "q-1", 12 * USDC, 3_000), 12 * USDC); // paid once only
}

#[test]
fn expired_quote_is_refused() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 12 * USDC, 7 * USDC, 30 * MIN);
    assert_eq!(
        pay_quote(&mut c, "q-1", 12 * USDC, 1_000 + 30 * MIN + 1),
        12 * USDC
    );
    assert!(c.get_order("q-1".into()).is_none());
}

#[test]
fn quoted_product_cannot_be_bought_without_a_quote() {
    let mut c = quote_setup();
    assert_eq!(pay_quote(&mut c, "q-9", 5 * USDC, 2_000), 5 * USDC);
}

#[test]
#[should_panic(expected = "price outside the owner's range")]
fn quote_above_max_is_refused() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 51 * USDC, 1, 30 * MIN);
}

#[test]
#[should_panic(expected = "price outside the owner's range")]
fn quote_below_min_is_refused() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 4 * USDC, 1, 30 * MIN);
}

#[test]
#[should_panic(expected = "expense cap above the owner's share of the price")]
fn quote_cannot_give_the_agent_a_big_budget() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 10 * USDC, 6 * USDC + 1, 30 * MIN);
}

#[test]
#[should_panic(expected = "expiry outside the owner's limit")]
fn quote_cannot_stay_open_too_long() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 10 * USDC, USDC, 30 * MIN + 1);
}

#[test]
#[should_panic(expected = "agent only")]
fn only_the_agent_quotes() {
    let mut c = quote_setup();
    at(customer(), 1_000);
    c.create_quote(
        "q-1".into(),
        "custom-brief".into(),
        U128(5 * USDC),
        U128(1),
        2_000,
    );
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_quote_rules() {
    let mut c = quote_setup();
    as_agent(|| {
        c.set_quote_rules(
            "custom-brief".into(),
            U128(1),
            U128(1_000 * USDC),
            10_000,
            1,
            true,
        )
    });
}

#[test]
fn quote_cap_replaces_the_product_cap() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 20 * USDC, 12 * USDC, 30 * MIN);
    pay_quote(&mut c, "q-1", 20 * USDC, 2_000);
    // Product cap is 3 USDC, but this quote allows 12: a 9 USDC dataset fits.
    let r =
        as_agent(|| c.request_purchase("q-1".into(), vendor(), U128(9 * USDC), "dataset".into()));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    resolve_purchase(&mut c, "q-1", 0, true);
    as_agent(|| c.mark_fulfilled("q-1".into(), "ab".repeat(32)));
    as_agent(|| c.settle("q-1".into(), inference(1_000_000)));
    let o = c.get_order("q-1".into()).unwrap();
    // E = min(9 + 1, 12, 20) = 10; D = 10; C = 3; O = 7; reimb = 1.
    assert_eq!(o.expenses_counted.0, 10 * USDC);
    let amt = |k: LegKind| {
        o.legs
            .iter()
            .find(|l| l.kind == k)
            .map(|l| l.amount.0)
            .unwrap_or(0)
    };
    assert_eq!(amt(LegKind::Contributor), 3 * USDC);
    assert_eq!(amt(LegKind::ReimbOwner), USDC);
    assert_eq!(
        9 * USDC + amt(LegKind::Owner) + amt(LegKind::Contributor) + amt(LegKind::ReimbOwner),
        20 * USDC
    );
}

#[test]
#[should_panic(expected = "purchase exceeds the order's expense cap")]
fn quote_cap_also_limits_purchases() {
    let mut c = quote_setup();
    quote(&mut c, "q-1", 10 * USDC, 2 * USDC, 30 * MIN);
    pay_quote(&mut c, "q-1", 10 * USDC, 2_000);
    let _ =
        as_agent(|| c.request_purchase("q-1".into(), vendor(), U128(3 * USDC), "dataset".into()));
}
