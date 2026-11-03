//! Buffer business contract ("buffer-desk").
//!
//! Holds customer payments in escrow, pays approved vendors directly from an
//! order's escrow, anchors the owner-signed policy hash, and settles each order
//! with the deterministic net-revenue formula:
//!
//!   V  = vendor purchases confirmed for the order (already paid from escrow)
//!   I  = inference claims (metered off-chain, reimbursed to the owner who
//!        prepaid the credits)
//!   E  = min(V + I, product.max_expense, gross)   (V <= max_expense always)
//!   D  = gross - E                               distributable (net)
//!   C  = floor(D * contributor_bps / 10000)      contributor
//!   O  = D - C                                   owner (receives rounding dust)
//!   reimb_owner = E - V
//!   Invariant: V + reimb_owner + C + O == gross.
//!
//! The agent never holds revenue or a spending float. It can only request
//! purchases from vendors on the owner's on-chain list (within the order's
//! expense cap; above the approval threshold the owner must approve that exact
//! purchase), mark orders fulfilled and request settlement. It cannot change
//! config, the split, recipients, vendors, products, the policy hash or the pause.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract, near, require, serde_json,
};

pub const BPS_DENOMINATOR: u128 = 10_000;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_ID_LEN: usize = 64;
const MAX_CLAIMS: usize = 16;
const MAX_PURCHASES: usize = 8;
const MAX_REF_LEN: usize = 128;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Products,
    Orders,
    Vendors,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Product {
    pub price: U128,
    pub max_expense: U128,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrderState {
    Paid,
    Fulfilled,
    Settling,
    Settled,
    Refunding,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExpenseCategory {
    Supplier,
    Inference,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ExpenseClaim {
    pub category: ExpenseCategory,
    pub amount: U128,
    pub evidence_ref: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PurchaseStatus {
    AwaitingApproval,
    Sending,
    Paid,
    Failed,
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Purchase {
    pub vendor: AccountId,
    pub amount: U128,
    pub memo: String,
    pub status: PurchaseStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LegKind {
    Owner,
    Contributor,
    ReimbOwner,
    Refund,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LegStatus {
    Pending,
    Confirmed,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    pub kind: LegKind,
    pub recipient: AccountId,
    pub amount: U128,
    pub status: LegStatus,
    pub attempts: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub sku: String,
    pub customer: AccountId,
    pub gross: U128,
    pub state: OrderState,
    pub paid_at_ns: u64,
    pub deadline_ns: u64,
    pub report_hash: Option<String>,
    pub purchases: Vec<Purchase>,
    pub refund_top_up: U128,
    pub expenses_counted: U128,
    pub claims: Vec<ExpenseClaim>,
    pub legs: Vec<Leg>,
}

impl Order {
    /// Confirmed vendor payments (already left escrow).
    fn vendor_paid(&self) -> u128 {
        self.purchases.iter().filter(|p| p.status == PurchaseStatus::Paid).map(|p| p.amount.0).sum()
    }
    /// Purchases that count against the expense cap: paid, in flight or awaiting approval.
    fn vendor_committed(&self) -> u128 {
        self.purchases
            .iter()
            .filter(|p| matches!(p.status, PurchaseStatus::Paid | PurchaseStatus::Sending | PurchaseStatus::AwaitingApproval))
            .map(|p| p.amount.0)
            .sum()
    }
    fn has_open_purchase(&self) -> bool {
        self.purchases.iter().any(|p| matches!(p.status, PurchaseStatus::Sending | PurchaseStatus::AwaitingApproval))
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub owner: AccountId,
    pub agent: AccountId,
    pub token_id: AccountId,
    pub owner_payout: AccountId,
    pub contributor: AccountId,
    pub contributor_bps: u16,
    pub purchase_approval_above: U128,
    pub order_ttl_ns: u64,
    pub paused: bool,
    pub policy_version: u32,
    pub policy_hash: Option<String>,
}

/// Pure settlement math, shared by `settle` and unit tests.
#[derive(Debug, PartialEq)]
pub struct Split {
    pub vendor_paid: u128,
    pub expenses: u128,
    pub distributable: u128,
    pub owner: u128,
    pub contributor: u128,
    pub reimb_owner: u128,
}

pub fn compute_split(gross: u128, max_expense: u128, contributor_bps: u16, vendor_paid: u128, inference_claimed: u128) -> Split {
    require!(contributor_bps as u128 <= BPS_DENOMINATOR, "contributor_bps out of range");
    require!(vendor_paid <= max_expense && vendor_paid <= gross, "vendor payments exceed the expense cap");
    let total = vendor_paid.checked_add(inference_claimed).expect("claim overflow");
    let expenses = total.min(max_expense).min(gross);
    let distributable = gross - expenses;
    let contributor = distributable * contributor_bps as u128 / BPS_DENOMINATOR;
    let owner = distributable - contributor;
    let reimb_owner = expenses - vendor_paid;
    require!(vendor_paid + reimb_owner + contributor + owner == gross, "settlement invariant violated");
    Split { vendor_paid, expenses, distributable, owner, contributor, reimb_owner }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PaymentMsg {
    order_id: String,
    sku: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct TopUpMsg {
    refund_top_up: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    agent: AccountId,
    token_id: AccountId,
    owner_payout: AccountId,
    contributor: AccountId,
    contributor_bps: u16,
    purchase_approval_above: U128,
    order_ttl_ns: u64,
    paused: bool,
    policy_version: u32,
    policy_hash: Option<String>,
    products: IterableMap<String, Product>,
    vendors: IterableMap<AccountId, bool>,
    orders: LookupMap<String, Order>,
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "buffer", "version": "1.1.0", "event": event, "data": [data] })
    ));
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[near]
impl Contract {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        token_id: AccountId,
        owner_payout: AccountId,
        contributor: AccountId,
        contributor_bps: u16,
        purchase_approval_above: U128,
        order_ttl_ns: u64,
    ) -> Self {
        let c = Self {
            owner,
            agent,
            token_id,
            owner_payout,
            contributor,
            contributor_bps,
            purchase_approval_above,
            order_ttl_ns,
            paused: false,
            policy_version: 0,
            policy_hash: None,
            products: IterableMap::new(StorageKey::Products),
            vendors: IterableMap::new(StorageKey::Vendors),
            orders: LookupMap::new(StorageKey::Orders),
        };
        c.assert_config_valid();
        c
    }

    // ---------- owner-only configuration ----------

    pub fn set_recipients(&mut self, owner_payout: AccountId, contributor: AccountId, contributor_bps: u16) {
        self.assert_owner();
        self.owner_payout = owner_payout;
        self.contributor = contributor;
        self.contributor_bps = contributor_bps;
        self.assert_config_valid();
        emit("config_updated", serde_json::json!({
            "owner_payout": self.owner_payout, "contributor": self.contributor, "contributor_bps": self.contributor_bps,
        }));
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agent = agent;
        self.assert_config_valid();
        emit("agent_updated", serde_json::json!({ "agent": self.agent }));
    }

    pub fn set_purchase_approval_above(&mut self, amount: U128) {
        self.assert_owner();
        self.purchase_approval_above = amount;
        emit("approval_threshold_set", serde_json::json!({ "above": amount }));
    }

    pub fn set_vendor(&mut self, vendor: AccountId, approved: bool) {
        self.assert_owner();
        require!(vendor != self.agent, "agent cannot be a vendor");
        self.vendors.insert(vendor.clone(), approved);
        emit("vendor_set", serde_json::json!({ "vendor": vendor, "approved": approved }));
    }

    pub fn set_product(&mut self, sku: String, price: U128, max_expense: U128, active: bool) {
        self.assert_owner();
        require!(valid_id(&sku), "invalid sku");
        require!(price.0 > 0, "price must be positive");
        require!(max_expense.0 <= price.0, "max_expense cannot exceed price");
        self.products.insert(sku.clone(), Product { price, max_expense, active });
        emit("product_set", serde_json::json!({ "sku": sku, "price": price, "max_expense": max_expense, "active": active }));
    }

    /// Anchors the sha256 of the owner-approved policy document.
    pub fn set_policy_hash(&mut self, version: u32, hash: String) {
        self.assert_owner();
        require!(version > self.policy_version, "policy version must increase");
        require!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "hash must be 64 lowercase hex chars");
        self.policy_version = version;
        self.policy_hash = Some(hash.clone());
        emit("policy_anchored", serde_json::json!({ "version": version, "hash": hash }));
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", serde_json::json!({ "by": env::predecessor_account_id() }));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", serde_json::json!({ "by": env::predecessor_account_id() }));
    }

    // ---------- payments (NEP-141 receiver) ----------

    /// Customer payment: exactly the product price for a new order id.
    /// Owner top-up: `{"refund_top_up":"<order_id>"}` adds to an order's refund pool.
    /// Anything else is returned to the sender in full.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            env::panic_str("only the configured token can pay");
        }
        let reject = |reason: &str| {
            emit("payment_rejected", serde_json::json!({ "sender": sender_id, "amount": amount, "reason": reason }));
            PromiseOrValue::Value(amount)
        };

        if let Ok(top) = serde_json::from_str::<TopUpMsg>(&msg) {
            if sender_id != self.owner {
                return reject("top_up_not_owner");
            }
            return match self.orders.get(&top.refund_top_up).cloned() {
                Some(mut order) if matches!(order.state, OrderState::Paid | OrderState::Fulfilled) => {
                    order.refund_top_up = U128(order.refund_top_up.0 + amount.0);
                    self.orders.insert(top.refund_top_up.clone(), order);
                    emit("refund_topped_up", serde_json::json!({ "order_id": top.refund_top_up, "amount": amount }));
                    PromiseOrValue::Value(U128(0))
                }
                _ => reject("top_up_bad_order"),
            };
        }

        if self.paused {
            return reject("paused");
        }
        let parsed: PaymentMsg = match serde_json::from_str(&msg) {
            Ok(p) => p,
            Err(_) => return reject("bad_msg"),
        };
        if !valid_id(&parsed.order_id) || !valid_id(&parsed.sku) {
            return reject("bad_id");
        }
        let product = match self.products.get(&parsed.sku) {
            Some(p) if p.active => p.clone(),
            _ => return reject("unknown_sku"),
        };
        if amount.0 != product.price.0 {
            return reject("wrong_amount");
        }
        if self.orders.contains_key(&parsed.order_id) {
            return reject("duplicate_order");
        }
        let now = env::block_timestamp();
        self.orders.insert(
            parsed.order_id.clone(),
            Order {
                sku: parsed.sku.clone(),
                customer: sender_id.clone(),
                gross: amount,
                state: OrderState::Paid,
                paid_at_ns: now,
                deadline_ns: now + self.order_ttl_ns,
                report_hash: None,
                purchases: vec![],
                refund_top_up: U128(0),
                expenses_counted: U128(0),
                claims: vec![],
                legs: vec![],
            },
        );
        emit("payment_received", serde_json::json!({ "order_id": parsed.order_id, "sku": parsed.sku, "customer": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    // ---------- procurement ----------

    /// Agent asks the contract to pay an approved vendor from the order's escrow.
    /// At or below the approval threshold it pays immediately; above it, the
    /// purchase waits for the owner to approve exactly this vendor and amount.
    /// Returns the purchase index.
    pub fn request_purchase(&mut self, order_id: String, vendor: AccountId, amount: U128, memo: String) -> PromiseOrValue<u32> {
        self.assert_agent();
        require!(!self.paused, "paused");
        require!(amount.0 > 0, "amount must be positive");
        require!(memo.len() <= MAX_REF_LEN, "memo too long");
        require!(self.vendors.get(&vendor).copied().unwrap_or(false), "vendor is not approved");
        let mut order = self.order_or_panic(&order_id);
        require!(order.state == OrderState::Paid, "order is not in Paid state");
        require!(order.purchases.len() < MAX_PURCHASES, "too many purchases");
        let product = self.products.get(&order.sku).expect("product missing").clone();
        require!(order.vendor_committed() + amount.0 <= product.max_expense.0, "purchase exceeds the order's expense cap");

        let needs_approval = amount.0 > self.purchase_approval_above.0;
        let status = if needs_approval { PurchaseStatus::AwaitingApproval } else { PurchaseStatus::Sending };
        order.purchases.push(Purchase { vendor: vendor.clone(), amount, memo: memo.clone(), status });
        let index = (order.purchases.len() - 1) as u32;
        self.orders.insert(order_id.clone(), order);

        emit(
            if needs_approval { "purchase_awaiting_approval" } else { "purchase_requested" },
            serde_json::json!({ "order_id": order_id, "index": index, "vendor": vendor, "amount": amount, "memo": memo }),
        );
        if needs_approval {
            PromiseOrValue::Value(index)
        } else {
            PromiseOrValue::Promise(self.send_purchase(&order_id, index, &vendor, amount))
        }
    }

    /// Owner approves one specific pending purchase (vendor and amount are fixed by its index).
    pub fn approve_purchase(&mut self, order_id: String, index: u32) -> Promise {
        self.assert_owner();
        require!(!self.paused, "paused");
        let mut order = self.order_or_panic(&order_id);
        require!(order.state == OrderState::Paid, "order is not in Paid state");
        let p = order.purchases.get_mut(index as usize).expect("no such purchase");
        require!(p.status == PurchaseStatus::AwaitingApproval, "purchase is not awaiting approval");
        require!(self.vendors.get(&p.vendor).copied().unwrap_or(false), "vendor is no longer approved");
        p.status = PurchaseStatus::Sending;
        let (vendor, amount) = (p.vendor.clone(), p.amount);
        self.orders.insert(order_id.clone(), order);
        emit("purchase_approved", serde_json::json!({ "order_id": order_id, "index": index, "by": env::predecessor_account_id() }));
        self.send_purchase(&order_id, index, &vendor, amount)
    }

    pub fn reject_purchase(&mut self, order_id: String, index: u32) {
        self.assert_owner();
        let mut order = self.order_or_panic(&order_id);
        let p = order.purchases.get_mut(index as usize).expect("no such purchase");
        require!(p.status == PurchaseStatus::AwaitingApproval, "purchase is not awaiting approval");
        p.status = PurchaseStatus::Rejected;
        self.orders.insert(order_id.clone(), order);
        emit("purchase_rejected", serde_json::json!({ "order_id": order_id, "index": index }));
    }

    #[private]
    pub fn on_purchase_resolved(&mut self, order_id: String, index: u32, #[callback_result] result: Result<(), PromiseError>) {
        let mut order = self.order_or_panic(&order_id);
        let ok = result.is_ok();
        let p = order.purchases.get_mut(index as usize).expect("no such purchase");
        p.status = if ok { PurchaseStatus::Paid } else { PurchaseStatus::Failed };
        let (vendor, amount) = (p.vendor.clone(), p.amount);
        self.orders.insert(order_id.clone(), order);
        emit(if ok { "purchase_paid" } else { "purchase_failed" }, serde_json::json!({
            "order_id": order_id, "index": index, "vendor": vendor, "amount": amount,
        }));
    }

    // ---------- fulfilment and settlement ----------

    pub fn mark_fulfilled(&mut self, order_id: String, report_hash: String) {
        self.assert_agent();
        require!(!self.paused, "paused");
        require!(report_hash.len() == 64 && report_hash.chars().all(|c| c.is_ascii_hexdigit()), "bad report hash");
        let mut order = self.order_or_panic(&order_id);
        require!(order.state == OrderState::Paid, "order is not in Paid state");
        require!(!order.has_open_purchase(), "a purchase is still open");
        order.state = OrderState::Fulfilled;
        order.report_hash = Some(report_hash.clone());
        self.orders.insert(order_id.clone(), order);
        emit("order_fulfilled", serde_json::json!({ "order_id": order_id, "report_hash": report_hash }));
    }

    /// Settles a fulfilled order exactly once. `claims` may contain only
    /// inference claims; vendor costs are already recorded on-chain.
    pub fn settle(&mut self, order_id: String, claims: Vec<ExpenseClaim>) -> Promise {
        self.assert_agent_or_owner();
        require!(!self.paused, "paused");
        require!(claims.len() <= MAX_CLAIMS, "too many claims");
        for c in &claims {
            require!(c.category == ExpenseCategory::Inference, "only inference claims; vendor costs are on-chain");
            require!(!c.evidence_ref.is_empty() && c.evidence_ref.len() <= MAX_REF_LEN, "each claim needs evidence");
        }
        let mut order = self.order_or_panic(&order_id);
        require!(order.state == OrderState::Fulfilled, "order is not in Fulfilled state");
        let product = self.products.get(&order.sku).expect("product missing").clone();
        let inference: u128 = claims.iter().map(|c| c.amount.0).fold(0u128, |a, b| a.checked_add(b).expect("claim overflow"));
        let split = compute_split(order.gross.0, product.max_expense.0, self.contributor_bps, order.vendor_paid(), inference);

        let candidates = [
            (LegKind::Owner, self.owner_payout.clone(), split.owner),
            (LegKind::Contributor, self.contributor.clone(), split.contributor),
            (LegKind::ReimbOwner, self.owner_payout.clone(), split.reimb_owner),
        ];
        order.legs = candidates
            .into_iter()
            .filter(|(_, _, amt)| *amt > 0)
            .map(|(kind, recipient, amt)| Leg { kind, recipient, amount: U128(amt), status: LegStatus::Pending, attempts: 1 })
            .collect();
        require!(!order.legs.is_empty(), "nothing to distribute");
        order.state = OrderState::Settling;
        order.expenses_counted = U128(split.expenses);
        order.claims = claims;
        let legs = order.legs.clone();
        self.orders.insert(order_id.clone(), order);

        emit("settlement_started", serde_json::json!({
            "order_id": order_id, "gross": U128(split.expenses + split.distributable),
            "vendor_paid": U128(split.vendor_paid), "expenses_counted": U128(split.expenses),
            "distributable": U128(split.distributable), "owner": U128(split.owner),
            "contributor": U128(split.contributor), "reimb_owner": U128(split.reimb_owner),
            "contributor_bps": self.contributor_bps,
        }));

        let mut promise: Option<Promise> = None;
        for (i, leg) in legs.iter().enumerate() {
            let p = self.send_leg(&order_id, i as u32, leg);
            promise = Some(match promise { None => p, Some(acc) => acc.and(p) });
        }
        promise.expect("no legs to pay")
    }

    /// Re-sends one failed leg. Never re-runs the whole settlement.
    pub fn retry_leg(&mut self, order_id: String, leg_index: u32) -> Promise {
        self.assert_agent_or_owner();
        let mut order = self.order_or_panic(&order_id);
        require!(order.state == OrderState::Settling || order.state == OrderState::Refunding, "order has no open legs");
        let leg = order.legs.get_mut(leg_index as usize).expect("no such leg");
        require!(leg.status == LegStatus::Failed, "leg is not failed");
        leg.status = LegStatus::Pending;
        leg.attempts += 1;
        let leg = leg.clone();
        self.orders.insert(order_id.clone(), order);
        self.send_leg(&order_id, leg_index, &leg)
    }

    /// Refunds what the order still holds in escrow (gross minus confirmed vendor
    /// payments) plus any owner top-up. To make a customer whole after vendor
    /// spend, the owner tops up first with `{"refund_top_up":"<order_id>"}`.
    /// Owner can refund any order not yet settling (with no purchase in flight);
    /// anyone can trigger it once the deadline passes unfulfilled.
    pub fn refund(&mut self, order_id: String) -> Promise {
        let mut order = self.order_or_panic(&order_id);
        let caller = env::predecessor_account_id();
        let expired = env::block_timestamp() > order.deadline_ns && order.state == OrderState::Paid;
        require!(
            (caller == self.owner && matches!(order.state, OrderState::Paid | OrderState::Fulfilled)) || expired,
            "refund not permitted"
        );
        require!(!order.purchases.iter().any(|p| p.status == PurchaseStatus::Sending), "a purchase is in flight");
        for p in order.purchases.iter_mut() {
            if p.status == PurchaseStatus::AwaitingApproval {
                p.status = PurchaseStatus::Rejected;
            }
        }
        let amount = order.gross.0 - order.vendor_paid() + order.refund_top_up.0;
        let shortfall = order.gross.0.saturating_sub(amount);
        let leg = Leg { kind: LegKind::Refund, recipient: order.customer.clone(), amount: U128(amount), status: LegStatus::Pending, attempts: 1 };
        order.legs = vec![leg.clone()];
        order.state = OrderState::Refunding;
        self.orders.insert(order_id.clone(), order);
        emit("refund_started", serde_json::json!({ "order_id": order_id, "amount": leg.amount, "to": leg.recipient, "shortfall": U128(shortfall) }));
        self.send_leg(&order_id, 0, &leg)
    }

    #[private]
    pub fn on_leg_resolved(&mut self, order_id: String, leg_index: u32, #[callback_result] result: Result<(), PromiseError>) {
        let mut order = self.order_or_panic(&order_id);
        let ok = result.is_ok();
        let (kind, recipient, amount) = {
            let leg = order.legs.get_mut(leg_index as usize).expect("no such leg");
            leg.status = if ok { LegStatus::Confirmed } else { LegStatus::Failed };
            (leg.kind, leg.recipient.clone(), leg.amount)
        };
        emit(if ok { "leg_confirmed" } else { "leg_failed" }, serde_json::json!({
            "order_id": order_id, "leg_index": leg_index, "kind": kind, "recipient": recipient, "amount": amount,
        }));
        if order.legs.iter().all(|l| l.status == LegStatus::Confirmed) {
            order.state = match order.state {
                OrderState::Settling => OrderState::Settled,
                OrderState::Refunding => OrderState::Refunded,
                s => s,
            };
            emit(if order.state == OrderState::Refunded { "order_refunded" } else { "order_settled" }, serde_json::json!({ "order_id": order_id }));
        }
        self.orders.insert(order_id, order);
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            token_id: self.token_id.clone(),
            owner_payout: self.owner_payout.clone(),
            contributor: self.contributor.clone(),
            contributor_bps: self.contributor_bps,
            purchase_approval_above: self.purchase_approval_above,
            order_ttl_ns: self.order_ttl_ns,
            paused: self.paused,
            policy_version: self.policy_version,
            policy_hash: self.policy_hash.clone(),
        }
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn get_products(&self) -> Vec<(String, Product)> {
        self.products.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_vendors(&self) -> Vec<(AccountId, bool)> {
        self.vendors.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    // ---------- internals ----------

    fn send_purchase(&self, order_id: &str, index: u32, vendor: &AccountId, amount: U128) -> Promise {
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(vendor.clone(), amount, Some(format!("buffer:{order_id}:purchase:{index}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_purchase_resolved(order_id.to_string(), index),
            )
    }

    fn send_leg(&self, order_id: &str, leg_index: u32, leg: &Leg) -> Promise {
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(leg.recipient.clone(), leg.amount, Some(format!("buffer:{order_id}:{leg_index}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_leg_resolved(order_id.to_string(), leg_index),
            )
    }

    fn order_or_panic(&self, order_id: &str) -> Order {
        self.orders.get(order_id).cloned().unwrap_or_else(|| env::panic_str("unknown order"))
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "agent only");
    }

    fn assert_agent_or_owner(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.agent || p == self.owner, "agent or owner only");
    }

    fn assert_config_valid(&self) {
        require!(self.contributor_bps as u128 <= BPS_DENOMINATOR, "contributor_bps out of range");
        require!(self.contributor != self.agent && self.owner_payout != self.agent, "agent cannot be a revenue recipient");
        require!(self.order_ttl_ns > 0, "order_ttl_ns must be positive");
    }
}

#[cfg(test)]
mod tests;
