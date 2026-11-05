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
//!
//! Self-funding treasury: at settlement the contract keeps
//!   R = min(floor(O * reserve_bps / 10000), reserve_target - reserve_balance)
//! of the owner's share as the business reserve (the contributor's share is never
//! touched). Refund shortfalls are paid from the reserve first. A separate NEAR
//! gas reserve, funded by the owner, refills the agent's wallet within a weekly cap.
//! Only the owner sets these rules or withdraws; the agent can only trigger them.
//!   Invariant: V + reimb_owner + C + O == gross.
//!
//! The agent never holds revenue or a spending float. It can only request
//! purchases from vendors on the owner's on-chain list (within the order's
//! expense cap; above the approval threshold the owner must approve that exact
//! purchase), mark orders fulfilled and request settlement. It cannot change
//! config, the split, recipients, vendors, products, the policy hash or the pause.
//!
//! Cross-chain purchases (Chain Signatures): the contract owns an Ethereum
//! treasury address derived by the NEAR MPC network. For an EVM purchase the
//! contract itself builds the EIP-1559 USDC transfer to an owner-approved EVM
//! vendor and asks the MPC network to sign its hash; the agent supplies only the
//! order, vendor, amount and capped gas fees, never bytes to sign. The owner
//! funds the treasury, so EVM purchase amounts are reimbursed to the owner at
//! settlement, inside the same expense cap:
//!   E  = min(V + X + I, product.max_expense, gross),  X = signed EVM purchases
//!   reimb_owner = E - V
//!
//! Subscriptions: a customer prepays N issues of a product at its price in one
//! payment, held in the subscription's own escrow. When an issue is due (never
//! earlier than the owner's interval) the agent can only move exactly one
//! issue's price into a new ordinary order for the same customer, which then
//! follows every rule above. The customer or owner can cancel at any time; the
//! unstarted issues are refunded to the customer in full.
//!
//! Quotes: for a quoted product the agent registers a price for one order
//! (`create_quote`) and the customer pays exactly that before it expires. The
//! contract refuses any quote outside the owner's rules: price within
//! [min_price, max_price], and an expense cap of at most `max_expense_bps` of the
//! price. That per-order cap replaces the product's cap everywhere above.
//!
//! More EVM chains: the same treasury address (one MPC-derived key) pays on
//! every EVM chain. Each extra chain has its own owner-set config, its own vendor
//! approvals and its own nonce. The agent names the chain and the vendor; which
//! chains, which vendors, the fee cap and the gas limit are the owner's.

pub mod evm;

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, ext_contract, near, require, serde_json,
};

pub const BPS_DENOMINATOR: u128 = 10_000;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_ID_LEN: usize = 64;
const MAX_CLAIMS: usize = 16;
const MAX_PURCHASES: usize = 8;
const MAX_REF_LEN: usize = 128;
const MPC_SIGN_GAS: Gas = Gas::from_tgas(50);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(10);
pub const EVM_TREASURY_PATH: &str = "buffer-treasury";
const WEEK_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [json])]
pub enum MpcPayload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct MpcSignRequest {
    pub path: String,
    pub payload_v2: MpcPayload,
    pub domain_id: u64,
}

#[ext_contract(ext_mpc)]
#[allow(dead_code)]
trait MpcSigner {
    fn sign(&mut self, request: MpcSignRequest);
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Products,
    Orders,
    Vendors,
    // Appended in the cross-chain upgrade; never reorder.
    EvmVendors,
    EvmPurchases,
    // Appended in the subscriptions upgrade.
    SubscriptionPlans,
    Subscriptions,
    // Appended in the quotes upgrade.
    QuoteRules,
    Quotes,
    // Appended in the multi-chain upgrade.
    EvmChains,
    EvmChainVendors,
    EvmChainNonces,
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
    /// Kept by the contract as the business reserve; never transferred. Appended: keep last.
    Reserve,
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
        self.purchases
            .iter()
            .filter(|p| p.status == PurchaseStatus::Paid)
            .map(|p| p.amount.0)
            .sum()
    }
    /// Purchases that count against the expense cap: paid, in flight or awaiting approval.
    fn vendor_committed(&self) -> u128 {
        self.purchases
            .iter()
            .filter(|p| {
                matches!(
                    p.status,
                    PurchaseStatus::Paid
                        | PurchaseStatus::Sending
                        | PurchaseStatus::AwaitingApproval
                )
            })
            .map(|p| p.amount.0)
            .sum()
    }
    fn has_open_purchase(&self) -> bool {
        self.purchases.iter().any(|p| {
            matches!(
                p.status,
                PurchaseStatus::Sending | PurchaseStatus::AwaitingApproval
            )
        })
    }
}

/// Owner-set Ethereum settings for cross-chain purchases.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmConfig {
    pub mpc_contract: AccountId,
    pub chain_id: u64,
    /// ERC-20 USDC contract on that chain ("0x" + 40 hex).
    pub usdc: String,
    /// Upper bound the agent may offer per gas unit, in wei.
    pub max_fee_per_gas_cap: U128,
    pub gas_limit: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum EvmPurchaseStatus {
    AwaitingApproval,
    Signing,
    /// Signature returned: treated as spent from here on.
    Signed,
    Failed,
    Rejected,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmSignature {
    /// Compressed R point, hex (33 bytes).
    pub big_r: String,
    /// s scalar, hex (32 bytes).
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmPurchase {
    pub vendor: String,
    pub amount: U128,
    pub chain_id: u64,
    pub token: String,
    pub gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    /// Assigned when signing starts.
    pub nonce: Option<u64>,
    /// keccak256 of the unsigned transaction, hex; set when signing starts.
    pub payload_hash: Option<String>,
    pub status: EvmPurchaseStatus,
    pub signature: Option<EvmSignature>,
}

impl EvmPurchase {
    fn committed(&self) -> bool {
        matches!(
            self.status,
            EvmPurchaseStatus::AwaitingApproval
                | EvmPurchaseStatus::Signing
                | EvmPurchaseStatus::Signed
        )
    }
    fn open(&self) -> bool {
        matches!(
            self.status,
            EvmPurchaseStatus::AwaitingApproval | EvmPurchaseStatus::Signing
        )
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

pub fn compute_split(
    gross: u128,
    max_expense: u128,
    contributor_bps: u16,
    vendor_paid: u128,
    inference_claimed: u128,
) -> Split {
    require!(
        contributor_bps as u128 <= BPS_DENOMINATOR,
        "contributor_bps out of range"
    );
    require!(
        vendor_paid <= max_expense && vendor_paid <= gross,
        "vendor payments exceed the expense cap"
    );
    let total = vendor_paid
        .checked_add(inference_claimed)
        .expect("claim overflow");
    let expenses = total.min(max_expense).min(gross);
    let distributable = gross - expenses;
    let contributor = distributable * contributor_bps as u128 / BPS_DENOMINATOR;
    let owner = distributable - contributor;
    let reimb_owner = expenses - vendor_paid;
    require!(
        vendor_paid + reimb_owner + contributor + owner == gross,
        "settlement invariant violated"
    );
    Split {
        vendor_paid,
        expenses,
        distributable,
        owner,
        contributor,
        reimb_owner,
    }
}

/// How much of the owner's share the reserve keeps: a percentage, never past the target.
pub fn reserve_cut(owner_share: u128, reserve_bps: u16, target: u128, balance: u128) -> u128 {
    let wanted = owner_share * reserve_bps as u128 / BPS_DENOMINATOR;
    wanted.min(target.saturating_sub(balance)).min(owner_share)
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PaymentMsg {
    order_id: String,
    sku: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SubscribeMsg {
    subscription_id: String,
    sku: String,
    issues: u32,
}

/// The owner's limits on prices the agent may quote for a product.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct QuoteRules {
    pub min_price: U128,
    pub max_price: U128,
    /// Largest expense cap a quote may carry, as a share of its price.
    pub max_expense_bps: u16,
    /// Longest a quote may stay open, in nanoseconds.
    pub max_ttl_ns: u64,
    pub active: bool,
}

/// One price for one order, registered by the agent within the owner's rules.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub sku: String,
    pub amount: U128,
    pub max_expense: U128,
    pub created_ns: u64,
    pub expires_ns: u64,
    pub paid: bool,
}

/// How a product may be sold as a subscription. Set by the owner.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SubscriptionPlan {
    /// Earliest gap between two issues, in nanoseconds.
    pub interval_ns: u64,
    pub min_issues: u32,
    pub max_issues: u32,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SubscriptionState {
    Active,
    Completed,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Subscription {
    pub sku: String,
    pub customer: AccountId,
    /// Price of one issue, fixed when the customer paid.
    pub issue_price: U128,
    pub issues_total: u32,
    pub issues_started: u32,
    pub interval_ns: u64,
    pub created_ns: u64,
    pub next_due_ns: u64,
    /// Prepayment for issues not yet started.
    pub escrow: U128,
    pub state: SubscriptionState,
    /// Refund of the unstarted issues after a cancellation.
    pub refund: Option<Leg>,
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
    // ---- cross-chain upgrade (appended; see `migrate`) ----
    evm: Option<EvmConfig>,
    evm_vendors: IterableMap<String, bool>,
    evm_purchases: LookupMap<String, Vec<EvmPurchase>>,
    evm_nonce: u64,
    // ---- treasury upgrade (appended) ----
    treasury: Treasury,
    // ---- subscriptions upgrade (appended; see `migrate`) ----
    subscription_plans: IterableMap<String, SubscriptionPlan>,
    subscriptions: LookupMap<String, Subscription>,
    // ---- quotes upgrade (appended; see `migrate`) ----
    quote_rules: IterableMap<String, QuoteRules>,
    quotes: LookupMap<String, Quote>,
    // ---- multi-chain upgrade (appended; see `migrate`) ----
    /// EVM chains besides the original one in `evm`, by chain id.
    evm_chains: IterableMap<u64, EvmConfig>,
    /// "<chain_id>:<0xvendor>" -> approved, for chains in `evm_chains`.
    evm_chain_vendors: IterableMap<String, bool>,
    evm_chain_nonces: LookupMap<u64, u64>,
}

/// Self-funding treasury state and the owner's rules for it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Treasury {
    /// Share of the owner's 70% kept as reserve, in basis points.
    pub reserve_bps: u16,
    /// Stop keeping once the reserve reaches this (USDC units).
    pub reserve_target: U128,
    /// USDC held by the contract as the business reserve.
    pub reserve_balance: U128,
    /// NEAR (yocto) the owner deposited for the agent's gas.
    pub gas_reserve: U128,
    /// One refill, in yoctoNEAR.
    pub gas_refill_amount: U128,
    /// Most refills may send in a rolling week, in yoctoNEAR.
    pub gas_week_cap: U128,
    pub gas_week_start_ns: u64,
    pub gas_spent_week: U128,
}

/// State layout before the multi-chain upgrade, read once by `migrate`.
#[near(serializers = [borsh])]
pub(crate) struct ContractV5 {
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
    evm: Option<EvmConfig>,
    evm_vendors: IterableMap<String, bool>,
    evm_purchases: LookupMap<String, Vec<EvmPurchase>>,
    evm_nonce: u64,
    treasury: Treasury,
    subscription_plans: IterableMap<String, SubscriptionPlan>,
    subscriptions: LookupMap<String, Subscription>,
    quote_rules: IterableMap<String, QuoteRules>,
    quotes: LookupMap<String, Quote>,
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "buffer", "version": "1.1.0", "event": event, "data": [data] })
    ));
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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
            evm: None,
            evm_vendors: IterableMap::new(StorageKey::EvmVendors),
            evm_purchases: LookupMap::new(StorageKey::EvmPurchases),
            evm_nonce: 0,
            treasury: Treasury::default(),
            subscription_plans: IterableMap::new(StorageKey::SubscriptionPlans),
            subscriptions: LookupMap::new(StorageKey::Subscriptions),
            quote_rules: IterableMap::new(StorageKey::QuoteRules),
            quotes: LookupMap::new(StorageKey::Quotes),
            evm_chains: IterableMap::new(StorageKey::EvmChains),
            evm_chain_vendors: IterableMap::new(StorageKey::EvmChainVendors),
            evm_chain_nonces: LookupMap::new(StorageKey::EvmChainNonces),
        };
        c.assert_config_valid();
        c
    }

    /// One-time upgrade from the quotes layout. Keeps every existing field, order,
    /// purchase, settlement, the treasury, subscriptions and quotes; adds empty
    /// extra EVM chains.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV5 = env::state_read().expect("no prior state");
        emit("migrated", serde_json::json!({ "to": "multichain" }));
        Self {
            owner: old.owner,
            agent: old.agent,
            token_id: old.token_id,
            owner_payout: old.owner_payout,
            contributor: old.contributor,
            contributor_bps: old.contributor_bps,
            purchase_approval_above: old.purchase_approval_above,
            order_ttl_ns: old.order_ttl_ns,
            paused: old.paused,
            policy_version: old.policy_version,
            policy_hash: old.policy_hash,
            products: old.products,
            vendors: old.vendors,
            orders: old.orders,
            evm: old.evm,
            evm_vendors: old.evm_vendors,
            evm_purchases: old.evm_purchases,
            evm_nonce: old.evm_nonce,
            treasury: old.treasury,
            subscription_plans: old.subscription_plans,
            subscriptions: old.subscriptions,
            quote_rules: old.quote_rules,
            quotes: old.quotes,
            evm_chains: IterableMap::new(StorageKey::EvmChains),
            evm_chain_vendors: IterableMap::new(StorageKey::EvmChainVendors),
            evm_chain_nonces: LookupMap::new(StorageKey::EvmChainNonces),
        }
    }

    // ---------- owner-only configuration ----------

    pub fn set_recipients(
        &mut self,
        owner_payout: AccountId,
        contributor: AccountId,
        contributor_bps: u16,
    ) {
        self.assert_owner();
        self.owner_payout = owner_payout;
        self.contributor = contributor;
        self.contributor_bps = contributor_bps;
        self.assert_config_valid();
        emit(
            "config_updated",
            serde_json::json!({
                "owner_payout": self.owner_payout, "contributor": self.contributor, "contributor_bps": self.contributor_bps,
            }),
        );
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
        emit(
            "approval_threshold_set",
            serde_json::json!({ "above": amount }),
        );
    }

    pub fn set_vendor(&mut self, vendor: AccountId, approved: bool) {
        self.assert_owner();
        require!(vendor != self.agent, "agent cannot be a vendor");
        self.vendors.insert(vendor.clone(), approved);
        emit(
            "vendor_set",
            serde_json::json!({ "vendor": vendor, "approved": approved }),
        );
    }

    pub fn set_product(&mut self, sku: String, price: U128, max_expense: U128, active: bool) {
        self.assert_owner();
        require!(valid_id(&sku), "invalid sku");
        require!(price.0 > 0, "price must be positive");
        require!(max_expense.0 <= price.0, "max_expense cannot exceed price");
        self.products.insert(
            sku.clone(),
            Product {
                price,
                max_expense,
                active,
            },
        );
        emit(
            "product_set",
            serde_json::json!({ "sku": sku, "price": price, "max_expense": max_expense, "active": active }),
        );
    }

    /// Anchors the sha256 of the owner-approved policy document.
    /// Lets customers prepay `min_issues..=max_issues` issues of an existing product,
    /// at most one issue per `interval_ns`. `active: false` stops new subscriptions only.
    pub fn set_subscription_plan(
        &mut self,
        sku: String,
        interval_ns: u64,
        min_issues: u32,
        max_issues: u32,
        active: bool,
    ) {
        self.assert_owner();
        require!(self.products.contains_key(&sku), "unknown product");
        require!(interval_ns > 0, "interval must be positive");
        require!(
            min_issues >= 1 && min_issues <= max_issues && max_issues <= 52,
            "issues out of range"
        );
        self.subscription_plans.insert(
            sku.clone(),
            SubscriptionPlan {
                interval_ns,
                min_issues,
                max_issues,
                active,
            },
        );
        emit(
            "subscription_plan_set",
            serde_json::json!({ "sku": sku, "interval_ns": interval_ns, "min_issues": min_issues, "max_issues": max_issues, "active": active }),
        );
    }

    /// Lets the agent quote `sku` per order within these limits. `active: false`
    /// switches quoting off; the product then sells at its listed price again.
    pub fn set_quote_rules(
        &mut self,
        sku: String,
        min_price: U128,
        max_price: U128,
        max_expense_bps: u16,
        max_ttl_ns: u64,
        active: bool,
    ) {
        self.assert_owner();
        require!(self.products.contains_key(&sku), "unknown product");
        require!(
            min_price.0 > 0 && min_price.0 <= max_price.0,
            "bad price range"
        );
        require!(
            max_expense_bps as u128 <= BPS_DENOMINATOR,
            "max_expense_bps out of range"
        );
        require!(max_ttl_ns > 0, "ttl must be positive");
        self.quote_rules.insert(
            sku.clone(),
            QuoteRules {
                min_price,
                max_price,
                max_expense_bps,
                max_ttl_ns,
                active,
            },
        );
        emit(
            "quote_rules_set",
            serde_json::json!({
                "sku": sku, "min_price": min_price, "max_price": max_price,
                "max_expense_bps": max_expense_bps, "max_ttl_ns": max_ttl_ns, "active": active,
            }),
        );
    }

    pub fn set_evm_config(&mut self, config: EvmConfig) {
        self.assert_owner();
        require!(
            evm::parse_address(&config.usdc).is_some(),
            "usdc must be a 0x address"
        );
        require!(
            config.gas_limit >= 21_000 && config.gas_limit <= 500_000,
            "gas_limit out of range"
        );
        require!(config.max_fee_per_gas_cap.0 > 0, "fee cap must be positive");
        let mut config = config;
        config.usdc = config.usdc.to_lowercase();
        emit("evm_config_set", serde_json::json!({ "config": config }));
        self.evm = Some(config);
    }

    pub fn set_evm_vendor(&mut self, vendor: String, approved: bool) {
        self.assert_owner();
        let a = evm::parse_address(&vendor).expect("vendor must be a 0x address");
        let key = evm::address_string(&a);
        self.evm_vendors.insert(key.clone(), approved);
        emit(
            "evm_vendor_set",
            serde_json::json!({ "vendor": key, "approved": approved }),
        );
    }

    /// Resync the treasury nonce, e.g. after a signed transaction was never mined.
    /// Adds or updates another EVM chain the treasury may pay on.
    pub fn set_evm_chain(&mut self, config: EvmConfig) {
        self.assert_owner();
        require!(
            self.evm.as_ref().map(|c| c.chain_id) != Some(config.chain_id),
            "use set_evm_config for the original chain"
        );
        require!(
            evm::parse_address(&config.usdc).is_some(),
            "usdc must be a 0x address"
        );
        require!(
            config.gas_limit >= 21_000 && config.gas_limit <= 500_000,
            "gas_limit out of range"
        );
        require!(config.max_fee_per_gas_cap.0 > 0, "fee cap must be positive");
        let mut config = config;
        config.usdc = config.usdc.to_lowercase();
        emit("evm_chain_set", serde_json::json!({ "config": config }));
        self.evm_chains.insert(config.chain_id, config);
    }

    pub fn set_evm_chain_vendor(&mut self, chain_id: u64, vendor: String, approved: bool) {
        self.assert_owner();
        require!(self.evm_chains.contains_key(&chain_id), "unknown chain");
        let a = evm::parse_address(&vendor).expect("vendor must be a 0x address");
        let key = format!("{chain_id}:{}", evm::address_string(&a));
        self.evm_chain_vendors.insert(key.clone(), approved);
        emit(
            "evm_vendor_set",
            serde_json::json!({ "chain_id": chain_id, "vendor": evm::address_string(&a), "approved": approved }),
        );
    }

    /// Resyncs one chain's nonce with the treasury's on-chain count.
    pub fn set_evm_chain_nonce(&mut self, chain_id: u64, nonce: u64) {
        self.assert_owner();
        require!(self.evm_chains.contains_key(&chain_id), "unknown chain");
        self.evm_chain_nonces.insert(chain_id, nonce);
        emit(
            "evm_nonce_set",
            serde_json::json!({ "chain_id": chain_id, "nonce": nonce }),
        );
    }

    pub fn set_evm_nonce(&mut self, nonce: u64) {
        self.assert_owner();
        self.evm_nonce = nonce;
        emit("evm_nonce_set", serde_json::json!({ "nonce": nonce }));
    }

    // ---------- treasury (owner rules, agent triggers) ----------

    pub fn set_treasury_rules(
        &mut self,
        reserve_bps: u16,
        reserve_target: U128,
        gas_refill_amount: U128,
        gas_week_cap: U128,
    ) {
        self.assert_owner();
        require!(
            reserve_bps as u128 <= BPS_DENOMINATOR,
            "reserve_bps out of range"
        );
        require!(
            gas_refill_amount.0 <= gas_week_cap.0,
            "one refill cannot exceed the weekly cap"
        );
        let t = &mut self.treasury;
        t.reserve_bps = reserve_bps;
        t.reserve_target = reserve_target;
        t.gas_refill_amount = gas_refill_amount;
        t.gas_week_cap = gas_week_cap;
        emit(
            "treasury_rules_set",
            serde_json::json!({ "reserve_bps": reserve_bps, "reserve_target": reserve_target, "gas_refill_amount": gas_refill_amount, "gas_week_cap": gas_week_cap }),
        );
    }

    /// Owner deposits NEAR the agent's gas refills are paid from.
    #[payable]
    pub fn fund_gas_reserve(&mut self) {
        self.assert_owner();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to fund the gas reserve");
        self.treasury.gas_reserve = U128(self.treasury.gas_reserve.0 + amount);
        emit(
            "gas_reserve_funded",
            serde_json::json!({ "amount": U128(amount), "gas_reserve": self.treasury.gas_reserve }),
        );
    }

    /// Agent asks for one gas refill. The contract enforces the size and the weekly cap.
    pub fn refill_agent_gas(&mut self) -> Promise {
        self.assert_agent();
        require!(!self.paused, "paused");
        let now = env::block_timestamp();
        let t = &mut self.treasury;
        let amount = t.gas_refill_amount.0;
        require!(amount > 0, "gas refills are not enabled");
        require!(t.gas_reserve.0 >= amount, "gas reserve is too low");
        if now.saturating_sub(t.gas_week_start_ns) >= WEEK_NS {
            t.gas_week_start_ns = now;
            t.gas_spent_week = U128(0);
        }
        require!(
            t.gas_spent_week.0 + amount <= t.gas_week_cap.0,
            "weekly gas refill cap reached"
        );
        t.gas_spent_week = U128(t.gas_spent_week.0 + amount);
        t.gas_reserve = U128(t.gas_reserve.0 - amount);
        emit(
            "gas_refilled",
            serde_json::json!({ "to": self.agent, "amount": U128(amount), "gas_reserve": t.gas_reserve, "spent_this_week": t.gas_spent_week }),
        );
        Promise::new(self.agent.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn withdraw_gas_reserve(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.treasury.gas_reserve.0,
            "amount exceeds the gas reserve"
        );
        self.treasury.gas_reserve = U128(self.treasury.gas_reserve.0 - amount.0);
        emit(
            "gas_reserve_withdrawn",
            serde_json::json!({ "amount": amount, "to": self.owner }),
        );
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Owner takes USDC out of the business reserve. Restored if the transfer fails.
    pub fn withdraw_reserve(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.treasury.reserve_balance.0,
            "amount exceeds the reserve"
        );
        self.treasury.reserve_balance = U128(self.treasury.reserve_balance.0 - amount.0);
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                self.owner_payout.clone(),
                amount,
                Some("buffer:reserve-withdrawal".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_reserve_withdrawn(amount),
            )
    }

    #[private]
    pub fn on_reserve_withdrawn(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_ok() {
            emit(
                "reserve_withdrawn",
                serde_json::json!({ "amount": amount, "to": self.owner_payout }),
            );
        } else {
            self.treasury.reserve_balance = U128(self.treasury.reserve_balance.0 + amount.0);
            emit(
                "reserve_withdrawal_failed",
                serde_json::json!({ "amount": amount }),
            );
        }
    }

    pub fn set_policy_hash(&mut self, version: u32, hash: String) {
        self.assert_owner();
        require!(
            version > self.policy_version,
            "policy version must increase"
        );
        require!(
            hash.len() == 64
                && hash
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "hash must be 64 lowercase hex chars"
        );
        self.policy_version = version;
        self.policy_hash = Some(hash.clone());
        emit(
            "policy_anchored",
            serde_json::json!({ "version": version, "hash": hash }),
        );
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit(
            "paused",
            serde_json::json!({ "by": env::predecessor_account_id() }),
        );
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit(
            "unpaused",
            serde_json::json!({ "by": env::predecessor_account_id() }),
        );
    }

    // ---------- payments (NEP-141 receiver) ----------

    /// Customer payment: exactly the product price for a new order id.
    /// Owner top-up: `{"refund_top_up":"<order_id>"}` adds to an order's refund pool.
    /// Anything else is returned to the sender in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            env::panic_str("only the configured token can pay");
        }
        let reject = |reason: &str| {
            emit(
                "payment_rejected",
                serde_json::json!({ "sender": sender_id, "amount": amount, "reason": reason }),
            );
            PromiseOrValue::Value(amount)
        };

        if let Ok(top) = serde_json::from_str::<TopUpMsg>(&msg) {
            if sender_id != self.owner {
                return reject("top_up_not_owner");
            }
            return match self.orders.get(&top.refund_top_up).cloned() {
                Some(mut order)
                    if matches!(order.state, OrderState::Paid | OrderState::Fulfilled) =>
                {
                    order.refund_top_up = U128(order.refund_top_up.0 + amount.0);
                    self.orders.insert(top.refund_top_up.clone(), order);
                    emit(
                        "refund_topped_up",
                        serde_json::json!({ "order_id": top.refund_top_up, "amount": amount }),
                    );
                    PromiseOrValue::Value(U128(0))
                }
                _ => reject("top_up_bad_order"),
            };
        }

        if self.paused {
            return reject("paused");
        }
        if let Ok(sub) = serde_json::from_str::<SubscribeMsg>(&msg) {
            return match self.subscribe(&sender_id, amount, sub) {
                Ok(()) => PromiseOrValue::Value(U128(0)),
                Err(reason) => reject(reason),
            };
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
        let now = env::block_timestamp();
        // A quoted product is sold only at the price the agent quoted for this order.
        let quote = self.quotes.get(&parsed.order_id).cloned();
        let price = match &quote {
            Some(q) => {
                if q.sku != parsed.sku {
                    return reject("wrong_sku");
                }
                if q.paid {
                    return reject("duplicate_order");
                }
                if now > q.expires_ns {
                    return reject("quote_expired");
                }
                q.amount.0
            }
            None => {
                if self
                    .quote_rules
                    .get(&parsed.sku)
                    .map(|r| r.active)
                    .unwrap_or(false)
                {
                    return reject("quote_required");
                }
                product.price.0
            }
        };
        if amount.0 != price {
            return reject("wrong_amount");
        }
        if self.orders.contains_key(&parsed.order_id) {
            return reject("duplicate_order");
        }
        if let Some(mut q) = quote {
            q.paid = true;
            self.quotes.insert(parsed.order_id.clone(), q);
        }
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
        emit(
            "payment_received",
            serde_json::json!({ "order_id": parsed.order_id, "sku": parsed.sku, "customer": sender_id, "amount": amount }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ---------- procurement ----------

    /// Agent asks the contract to pay an approved vendor from the order's escrow.
    /// At or below the approval threshold it pays immediately; above it, the
    /// purchase waits for the owner to approve exactly this vendor and amount.
    /// Returns the purchase index.
    pub fn request_purchase(
        &mut self,
        order_id: String,
        vendor: AccountId,
        amount: U128,
        memo: String,
    ) -> PromiseOrValue<u32> {
        self.assert_agent();
        require!(!self.paused, "paused");
        require!(amount.0 > 0, "amount must be positive");
        require!(memo.len() <= MAX_REF_LEN, "memo too long");
        require!(
            self.vendors.get(&vendor).copied().unwrap_or(false),
            "vendor is not approved"
        );
        let mut order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Paid,
            "order is not in Paid state"
        );
        require!(order.purchases.len() < MAX_PURCHASES, "too many purchases");
        require!(
            self.committed_spend(&order_id, &order) + amount.0
                <= self.expense_cap(&order_id, &order),
            "purchase exceeds the order's expense cap"
        );

        let needs_approval = amount.0 > self.purchase_approval_above.0;
        let status = if needs_approval {
            PurchaseStatus::AwaitingApproval
        } else {
            PurchaseStatus::Sending
        };
        order.purchases.push(Purchase {
            vendor: vendor.clone(),
            amount,
            memo: memo.clone(),
            status,
        });
        let index = (order.purchases.len() - 1) as u32;
        self.orders.insert(order_id.clone(), order);

        emit(
            if needs_approval {
                "purchase_awaiting_approval"
            } else {
                "purchase_requested"
            },
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
        require!(
            order.state == OrderState::Paid,
            "order is not in Paid state"
        );
        let p = order
            .purchases
            .get_mut(index as usize)
            .expect("no such purchase");
        require!(
            p.status == PurchaseStatus::AwaitingApproval,
            "purchase is not awaiting approval"
        );
        require!(
            self.vendors.get(&p.vendor).copied().unwrap_or(false),
            "vendor is no longer approved"
        );
        p.status = PurchaseStatus::Sending;
        let (vendor, amount) = (p.vendor.clone(), p.amount);
        self.orders.insert(order_id.clone(), order);
        emit(
            "purchase_approved",
            serde_json::json!({ "order_id": order_id, "index": index, "by": env::predecessor_account_id() }),
        );
        self.send_purchase(&order_id, index, &vendor, amount)
    }

    pub fn reject_purchase(&mut self, order_id: String, index: u32) {
        self.assert_owner();
        let mut order = self.order_or_panic(&order_id);
        let p = order
            .purchases
            .get_mut(index as usize)
            .expect("no such purchase");
        require!(
            p.status == PurchaseStatus::AwaitingApproval,
            "purchase is not awaiting approval"
        );
        p.status = PurchaseStatus::Rejected;
        self.orders.insert(order_id.clone(), order);
        emit(
            "purchase_rejected",
            serde_json::json!({ "order_id": order_id, "index": index }),
        );
    }

    #[private]
    pub fn on_purchase_resolved(
        &mut self,
        order_id: String,
        index: u32,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let mut order = self.order_or_panic(&order_id);
        let ok = result.is_ok();
        let p = order
            .purchases
            .get_mut(index as usize)
            .expect("no such purchase");
        p.status = if ok {
            PurchaseStatus::Paid
        } else {
            PurchaseStatus::Failed
        };
        let (vendor, amount) = (p.vendor.clone(), p.amount);
        self.orders.insert(order_id.clone(), order);
        emit(
            if ok {
                "purchase_paid"
            } else {
                "purchase_failed"
            },
            serde_json::json!({
                "order_id": order_id, "index": index, "vendor": vendor, "amount": amount,
            }),
        );
    }

    // ---------- cross-chain purchases (Chain Signatures) ----------

    /// Agent asks to pay an approved EVM vendor in USDC from the treasury.
    /// The contract builds the transaction; the agent only offers gas fees under the owner's cap.
    pub fn request_evm_purchase(
        &mut self,
        order_id: String,
        vendor: String,
        amount: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        chain_id: Option<u64>,
    ) -> PromiseOrValue<u32> {
        self.assert_agent();
        require!(!self.paused, "paused");
        let cfg = self.chain_config(chain_id);
        require!(amount.0 > 0, "amount must be positive");
        let vendor =
            evm::address_string(&evm::parse_address(&vendor).expect("vendor must be a 0x address"));
        require!(
            self.evm_vendor_approved(cfg.chain_id, &vendor),
            "evm vendor is not approved"
        );
        require!(
            max_fee_per_gas.0 > 0 && max_fee_per_gas.0 <= cfg.max_fee_per_gas_cap.0,
            "max_fee_per_gas above the owner's cap"
        );
        require!(
            max_priority_fee_per_gas.0 <= max_fee_per_gas.0,
            "priority fee above max fee"
        );
        let order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Paid,
            "order is not in Paid state"
        );
        let mut list = self
            .evm_purchases
            .get(&order_id)
            .cloned()
            .unwrap_or_default();
        require!(
            order.purchases.len() + list.len() < MAX_PURCHASES,
            "too many purchases"
        );
        require!(
            self.committed_spend(&order_id, &order) + amount.0
                <= self.expense_cap(&order_id, &order),
            "purchase exceeds the order's expense cap"
        );

        let needs_approval = amount.0 > self.purchase_approval_above.0;
        list.push(EvmPurchase {
            vendor: vendor.clone(),
            amount,
            chain_id: cfg.chain_id,
            token: cfg.usdc.clone(),
            gas_limit: cfg.gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            nonce: None,
            payload_hash: None,
            status: if needs_approval {
                EvmPurchaseStatus::AwaitingApproval
            } else {
                EvmPurchaseStatus::Signing
            },
            signature: None,
        });
        let index = (list.len() - 1) as u32;
        self.evm_purchases.insert(order_id.clone(), list);
        emit(
            if needs_approval {
                "evm_purchase_awaiting_approval"
            } else {
                "evm_purchase_requested"
            },
            serde_json::json!({ "order_id": order_id, "index": index, "vendor": vendor, "amount": amount, "chain_id": cfg.chain_id }),
        );
        if needs_approval {
            PromiseOrValue::Value(index)
        } else {
            PromiseOrValue::Promise(self.start_signing(&order_id, index, &cfg))
        }
    }

    pub fn approve_evm_purchase(&mut self, order_id: String, index: u32) -> Promise {
        self.assert_owner();
        require!(!self.paused, "paused");
        let chain_id = self
            .evm_purchases
            .get(&order_id)
            .and_then(|l| l.get(index as usize))
            .map(|p| p.chain_id)
            .expect("no such evm purchase");
        let cfg = self.chain_config(Some(chain_id));
        let order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Paid,
            "order is not in Paid state"
        );
        let mut list = self
            .evm_purchases
            .get(&order_id)
            .cloned()
            .expect("no evm purchases");
        let p = list.get_mut(index as usize).expect("no such evm purchase");
        require!(
            p.status == EvmPurchaseStatus::AwaitingApproval,
            "evm purchase is not awaiting approval"
        );
        let still_approved = self.evm_vendor_approved(p.chain_id, &p.vendor);
        require!(still_approved, "evm vendor is no longer approved");
        p.status = EvmPurchaseStatus::Signing;
        self.evm_purchases.insert(order_id.clone(), list);
        emit(
            "evm_purchase_approved",
            serde_json::json!({ "order_id": order_id, "index": index, "by": env::predecessor_account_id() }),
        );
        self.start_signing(&order_id, index, &cfg)
    }

    pub fn reject_evm_purchase(&mut self, order_id: String, index: u32) {
        self.assert_owner();
        let mut list = self
            .evm_purchases
            .get(&order_id)
            .cloned()
            .expect("no evm purchases");
        let p = list.get_mut(index as usize).expect("no such evm purchase");
        require!(
            p.status == EvmPurchaseStatus::AwaitingApproval,
            "evm purchase is not awaiting approval"
        );
        p.status = EvmPurchaseStatus::Rejected;
        self.evm_purchases.insert(order_id.clone(), list);
        emit(
            "evm_purchase_rejected",
            serde_json::json!({ "order_id": order_id, "index": index }),
        );
    }

    #[private]
    pub fn on_evm_signed(
        &mut self,
        order_id: String,
        index: u32,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) {
        let mut list = self
            .evm_purchases
            .get(&order_id)
            .cloned()
            .expect("no evm purchases");
        let p = list.get_mut(index as usize).expect("no such evm purchase");
        let sig = result.ok().and_then(|v| {
            let big_r = v.get("big_r")?.get("affine_point")?.as_str()?.to_string();
            let s = v.get("s")?.get("scalar")?.as_str()?.to_string();
            let recovery_id = u8::try_from(v.get("recovery_id")?.as_u64()?).ok()?;
            Some(EvmSignature {
                big_r,
                s,
                recovery_id,
            })
        });
        match sig {
            Some(sig) => {
                p.status = EvmPurchaseStatus::Signed;
                p.signature = Some(sig.clone());
                let (vendor, amount, nonce, hash) =
                    (p.vendor.clone(), p.amount, p.nonce, p.payload_hash.clone());
                self.evm_purchases.insert(order_id.clone(), list);
                emit(
                    "evm_purchase_signed",
                    serde_json::json!({ "order_id": order_id, "index": index, "vendor": vendor, "amount": amount, "nonce": nonce, "payload_hash": hash, "signature": sig }),
                );
            }
            None => {
                p.status = EvmPurchaseStatus::Failed;
                // Give the nonce back if nothing was signed after it.
                if let Some(n) = p.nonce {
                    self.give_back_nonce(p.chain_id, n);
                }
                self.evm_purchases.insert(order_id.clone(), list);
                emit(
                    "evm_purchase_sign_failed",
                    serde_json::json!({ "order_id": order_id, "index": index }),
                );
            }
        }
    }

    // ---------- fulfilment and settlement ----------

    pub fn mark_fulfilled(&mut self, order_id: String, report_hash: String) {
        self.assert_agent();
        require!(!self.paused, "paused");
        require!(
            report_hash.len() == 64 && report_hash.chars().all(|c| c.is_ascii_hexdigit()),
            "bad report hash"
        );
        let mut order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Paid,
            "order is not in Paid state"
        );
        require!(!order.has_open_purchase(), "a purchase is still open");
        require!(
            !self
                .evm_purchases
                .get(&order_id)
                .map(|l| l.iter().any(|p| p.open()))
                .unwrap_or(false),
            "a cross-chain purchase is still open"
        );
        order.state = OrderState::Fulfilled;
        order.report_hash = Some(report_hash.clone());
        self.orders.insert(order_id.clone(), order);
        emit(
            "order_fulfilled",
            serde_json::json!({ "order_id": order_id, "report_hash": report_hash }),
        );
    }

    /// Settles a fulfilled order exactly once. `claims` may contain only
    /// inference claims; vendor costs are already recorded on-chain.
    ///
    /// Each payout leg is its own promise chain (ft_transfer -> on_leg_resolved)
    /// and is detached rather than returned: NEAR forbids returning a joint
    /// promise (`a.and(b)`), so combining the legs would make settlement panic.
    pub fn settle(&mut self, order_id: String, claims: Vec<ExpenseClaim>) {
        self.assert_agent_or_owner();
        require!(!self.paused, "paused");
        require!(claims.len() <= MAX_CLAIMS, "too many claims");
        for c in &claims {
            require!(
                c.category == ExpenseCategory::Inference,
                "only inference claims; vendor costs are on-chain"
            );
            require!(
                !c.evidence_ref.is_empty() && c.evidence_ref.len() <= MAX_REF_LEN,
                "each claim needs evidence"
            );
        }
        let mut order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Fulfilled,
            "order is not in Fulfilled state"
        );
        let inference: u128 = claims
            .iter()
            .map(|c| c.amount.0)
            .fold(0u128, |a, b| a.checked_add(b).expect("claim overflow"));
        // Signed cross-chain purchases were paid from the owner-funded treasury: reimbursed like inference.
        let evm_paid = self.evm_signed_total(&order_id);
        let reimbursable = inference.checked_add(evm_paid).expect("claim overflow");
        let split = compute_split(
            order.gross.0,
            self.expense_cap(&order_id, &order),
            self.contributor_bps,
            order.vendor_paid(),
            reimbursable,
        );

        // Business reserve comes out of the owner's share only.
        let reserve = reserve_cut(
            split.owner,
            self.treasury.reserve_bps,
            self.treasury.reserve_target.0,
            self.treasury.reserve_balance.0,
        );
        self.treasury.reserve_balance = U128(self.treasury.reserve_balance.0 + reserve);
        let candidates = [
            (
                LegKind::Owner,
                self.owner_payout.clone(),
                split.owner - reserve,
            ),
            (
                LegKind::Contributor,
                self.contributor.clone(),
                split.contributor,
            ),
            (
                LegKind::ReimbOwner,
                self.owner_payout.clone(),
                split.reimb_owner,
            ),
            (LegKind::Reserve, env::current_account_id(), reserve),
        ];
        order.legs = candidates
            .into_iter()
            .filter(|(_, _, amt)| *amt > 0)
            .map(|(kind, recipient, amt)| {
                // The reserve leg never leaves the contract, so it is settled the moment it is counted.
                let status = if kind == LegKind::Reserve {
                    LegStatus::Confirmed
                } else {
                    LegStatus::Pending
                };
                Leg {
                    kind,
                    recipient,
                    amount: U128(amt),
                    status,
                    attempts: 1,
                }
            })
            .collect();
        require!(!order.legs.is_empty(), "nothing to distribute");
        order.state = if order.legs.iter().all(|l| l.status == LegStatus::Confirmed) {
            OrderState::Settled
        } else {
            OrderState::Settling
        };
        order.expenses_counted = U128(split.expenses);
        order.claims = claims;
        let legs = order.legs.clone();
        self.orders.insert(order_id.clone(), order);

        emit(
            "settlement_started",
            serde_json::json!({
                "order_id": order_id, "gross": U128(split.expenses + split.distributable),
                "vendor_paid": U128(split.vendor_paid), "expenses_counted": U128(split.expenses),
                "distributable": U128(split.distributable), "owner": U128(split.owner),
                "contributor": U128(split.contributor), "reimb_owner": U128(split.reimb_owner),
                "contributor_bps": self.contributor_bps, "evm_paid": U128(evm_paid),
                "reserve_kept": U128(reserve), "reserve_balance": self.treasury.reserve_balance,
            }),
        );

        for (i, leg) in legs.iter().enumerate() {
            if leg.status == LegStatus::Pending {
                self.send_leg(&order_id, i as u32, leg).detach();
            }
        }
    }

    /// Re-sends one failed leg. Never re-runs the whole settlement.
    pub fn retry_leg(&mut self, order_id: String, leg_index: u32) -> Promise {
        self.assert_agent_or_owner();
        let mut order = self.order_or_panic(&order_id);
        require!(
            order.state == OrderState::Settling || order.state == OrderState::Refunding,
            "order has no open legs"
        );
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
            (caller == self.owner
                && matches!(order.state, OrderState::Paid | OrderState::Fulfilled))
                || expired,
            "refund not permitted"
        );
        require!(
            !order
                .purchases
                .iter()
                .any(|p| p.status == PurchaseStatus::Sending),
            "a purchase is in flight"
        );
        if let Some(mut list) = self.evm_purchases.get(&order_id).cloned() {
            require!(
                !list.iter().any(|p| p.status == EvmPurchaseStatus::Signing),
                "a cross-chain signature is in flight"
            );
            for p in list
                .iter_mut()
                .filter(|p| p.status == EvmPurchaseStatus::AwaitingApproval)
            {
                p.status = EvmPurchaseStatus::Rejected;
            }
            self.evm_purchases.insert(order_id.clone(), list);
        }
        for p in order.purchases.iter_mut() {
            if p.status == PurchaseStatus::AwaitingApproval {
                p.status = PurchaseStatus::Rejected;
            }
        }
        let escrow = order.gross.0 - order.vendor_paid() + order.refund_top_up.0;
        // The business reserve covers what escrow and any top-up do not.
        let from_reserve = order
            .gross
            .0
            .saturating_sub(escrow)
            .min(self.treasury.reserve_balance.0);
        self.treasury.reserve_balance = U128(self.treasury.reserve_balance.0 - from_reserve);
        let amount = escrow + from_reserve;
        let shortfall = order.gross.0.saturating_sub(amount);
        let leg = Leg {
            kind: LegKind::Refund,
            recipient: order.customer.clone(),
            amount: U128(amount),
            status: LegStatus::Pending,
            attempts: 1,
        };
        order.legs = vec![leg.clone()];
        order.state = OrderState::Refunding;
        self.orders.insert(order_id.clone(), order);
        emit(
            "refund_started",
            serde_json::json!({ "order_id": order_id, "amount": leg.amount, "to": leg.recipient, "shortfall": U128(shortfall), "from_reserve": U128(from_reserve) }),
        );
        self.send_leg(&order_id, 0, &leg)
    }

    #[private]
    pub fn on_leg_resolved(
        &mut self,
        order_id: String,
        leg_index: u32,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let mut order = self.order_or_panic(&order_id);
        let ok = result.is_ok();
        let (kind, recipient, amount) = {
            let leg = order.legs.get_mut(leg_index as usize).expect("no such leg");
            leg.status = if ok {
                LegStatus::Confirmed
            } else {
                LegStatus::Failed
            };
            (leg.kind, leg.recipient.clone(), leg.amount)
        };
        emit(
            if ok { "leg_confirmed" } else { "leg_failed" },
            serde_json::json!({
                "order_id": order_id, "leg_index": leg_index, "kind": kind, "recipient": recipient, "amount": amount,
            }),
        );
        if order.legs.iter().all(|l| l.status == LegStatus::Confirmed) {
            order.state = match order.state {
                OrderState::Settling => OrderState::Settled,
                OrderState::Refunding => OrderState::Refunded,
                s => s,
            };
            emit(
                if order.state == OrderState::Refunded {
                    "order_refunded"
                } else {
                    "order_settled"
                },
                serde_json::json!({ "order_id": order_id }),
            );
        }
        self.orders.insert(order_id, order);
    }

    // ---------- quotes ----------

    /// Agent registers the price of one future order. The contract refuses any
    /// price or expense cap outside the owner's rules; the customer then pays
    /// exactly `amount` with `{"order_id": .., "sku": ..}` before `expires_ns`.
    pub fn create_quote(
        &mut self,
        order_id: String,
        sku: String,
        amount: U128,
        max_expense: U128,
        expires_ns: u64,
    ) {
        self.assert_agent();
        require!(!self.paused, "paused");
        require!(valid_id(&order_id) && valid_id(&sku), "bad id");
        let rules = self
            .quote_rules
            .get(&sku)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no quote rules for this product"));
        require!(rules.active, "quoting is off for this product");
        require!(
            self.products.get(&sku).map(|p| p.active).unwrap_or(false),
            "product is not active"
        );
        require!(
            amount.0 >= rules.min_price.0 && amount.0 <= rules.max_price.0,
            "price outside the owner's range"
        );
        require!(
            max_expense.0 * BPS_DENOMINATOR <= amount.0 * rules.max_expense_bps as u128,
            "expense cap above the owner's share of the price"
        );
        let now = env::block_timestamp();
        require!(
            expires_ns > now && expires_ns - now <= rules.max_ttl_ns,
            "expiry outside the owner's limit"
        );
        require!(
            !self.quotes.contains_key(&order_id) && !self.orders.contains_key(&order_id),
            "order id already used"
        );
        self.quotes.insert(
            order_id.clone(),
            Quote {
                sku: sku.clone(),
                amount,
                max_expense,
                created_ns: now,
                expires_ns,
                paid: false,
            },
        );
        emit(
            "quote_created",
            serde_json::json!({
                "order_id": order_id, "sku": sku, "amount": amount, "max_expense": max_expense, "expires_ns": expires_ns,
            }),
        );
    }

    // ---------- subscriptions ----------

    /// Agent opens the next issue of a subscription once it is due: moves exactly
    /// one issue's price from the subscription escrow into a new order
    /// `<subscription_id>-<n>` for the same customer. Returns the order id.
    pub fn start_issue(&mut self, subscription_id: String) -> String {
        self.assert_agent();
        require!(!self.paused, "paused");
        let mut sub = self
            .subscriptions
            .get(&subscription_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown subscription"));
        require!(
            sub.state == SubscriptionState::Active,
            "subscription is not active"
        );
        require!(sub.issues_started < sub.issues_total, "no issues left");
        let now = env::block_timestamp();
        require!(now >= sub.next_due_ns, "next issue is not due yet");
        require!(sub.escrow.0 >= sub.issue_price.0, "escrow too low");
        let n = sub.issues_started + 1;
        let order_id = format!("{subscription_id}-{n}");
        require!(!self.orders.contains_key(&order_id), "issue order exists");
        self.orders.insert(
            order_id.clone(),
            Order {
                sku: sub.sku.clone(),
                customer: sub.customer.clone(),
                gross: sub.issue_price,
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
        sub.escrow = U128(sub.escrow.0 - sub.issue_price.0);
        sub.issues_started = n;
        sub.next_due_ns = now + sub.interval_ns;
        if n == sub.issues_total {
            sub.state = SubscriptionState::Completed;
        }
        emit(
            "issue_started",
            serde_json::json!({
                "subscription_id": subscription_id, "order_id": order_id, "issue": n, "of": sub.issues_total,
                "amount": sub.issue_price, "escrow_left": sub.escrow, "next_due_ns": sub.next_due_ns,
            }),
        );
        self.subscriptions.insert(subscription_id, sub);
        order_id
    }

    /// Customer or owner stops a subscription. Every unstarted issue is refunded
    /// to the customer in full; issues already started finish as normal orders.
    /// Works while the business is paused.
    pub fn cancel_subscription(&mut self, subscription_id: String) {
        let mut sub = self
            .subscriptions
            .get(&subscription_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown subscription"));
        let caller = env::predecessor_account_id();
        require!(
            caller == sub.customer || caller == self.owner,
            "customer or owner only"
        );
        require!(
            sub.state == SubscriptionState::Active,
            "subscription is not active"
        );
        let amount = sub.escrow;
        sub.escrow = U128(0);
        sub.state = SubscriptionState::Cancelled;
        let refund = (amount.0 > 0).then(|| Leg {
            kind: LegKind::Refund,
            recipient: sub.customer.clone(),
            amount,
            status: LegStatus::Pending,
            attempts: 1,
        });
        sub.refund = refund.clone();
        let unstarted = sub.issues_total - sub.issues_started;
        self.subscriptions.insert(subscription_id.clone(), sub);
        emit(
            "subscription_cancelled",
            serde_json::json!({ "subscription_id": subscription_id, "by": caller, "issues_unstarted": unstarted, "refund": amount }),
        );
        if let Some(leg) = refund {
            self.send_subscription_refund(&subscription_id, &leg)
                .detach();
        }
    }

    /// Re-sends a failed subscription refund.
    pub fn retry_subscription_refund(&mut self, subscription_id: String) -> Promise {
        let mut sub = self
            .subscriptions
            .get(&subscription_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown subscription"));
        let caller = env::predecessor_account_id();
        require!(
            caller == sub.customer || caller == self.owner || caller == self.agent,
            "not permitted"
        );
        let leg = sub.refund.as_mut().expect("no refund");
        require!(leg.status == LegStatus::Failed, "refund is not failed");
        leg.status = LegStatus::Pending;
        leg.attempts += 1;
        let leg = leg.clone();
        self.subscriptions.insert(subscription_id.clone(), sub);
        self.send_subscription_refund(&subscription_id, &leg)
    }

    #[private]
    pub fn on_subscription_refunded(
        &mut self,
        subscription_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let mut sub = self
            .subscriptions
            .get(&subscription_id)
            .cloned()
            .expect("unknown subscription");
        let ok = result.is_ok();
        let leg = sub.refund.as_mut().expect("no refund");
        leg.status = if ok {
            LegStatus::Confirmed
        } else {
            LegStatus::Failed
        };
        emit(
            if ok {
                "subscription_refunded"
            } else {
                "subscription_refund_failed"
            },
            serde_json::json!({
                "subscription_id": subscription_id, "amount": leg.amount, "to": leg.recipient,
            }),
        );
        self.subscriptions.insert(subscription_id, sub);
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
        self.products
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_vendors(&self) -> Vec<(AccountId, bool)> {
        self.vendors.iter().map(|(k, v)| (k.clone(), *v)).collect()
    }

    pub fn get_quote(&self, order_id: String) -> Option<Quote> {
        self.quotes.get(&order_id).cloned()
    }

    pub fn get_quote_rules(&self) -> Vec<(String, QuoteRules)> {
        self.quote_rules
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_subscription(&self, subscription_id: String) -> Option<Subscription> {
        self.subscriptions.get(&subscription_id).cloned()
    }

    pub fn get_subscription_plans(&self) -> Vec<(String, SubscriptionPlan)> {
        self.subscription_plans
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get_treasury(&self) -> Treasury {
        self.treasury.clone()
    }

    pub fn get_evm_config(&self) -> Option<EvmConfig> {
        self.evm.clone()
    }

    pub fn get_evm_vendors(&self) -> Vec<(String, bool)> {
        self.evm_vendors
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    pub fn get_evm_chains(&self) -> Vec<EvmConfig> {
        self.evm_chains.values().cloned().collect()
    }

    pub fn get_evm_chain_vendors(&self) -> Vec<(String, bool)> {
        self.evm_chain_vendors
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    pub fn get_evm_chain_nonce(&self, chain_id: u64) -> u64 {
        self.evm_chain_nonces.get(&chain_id).copied().unwrap_or(0)
    }

    pub fn get_evm_nonce(&self) -> u64 {
        self.evm_nonce
    }

    pub fn get_evm_purchases(&self, order_id: String) -> Vec<EvmPurchase> {
        self.evm_purchases
            .get(&order_id)
            .cloned()
            .unwrap_or_default()
    }

    /// The unsigned transaction a purchase signs (hex), so anyone can rebuild and check it.
    pub fn get_evm_unsigned_tx(&self, order_id: String, index: u32) -> Option<String> {
        let p = self
            .evm_purchases
            .get(&order_id)?
            .get(index as usize)?
            .clone();
        Some(evm::to_hex(&evm::unsigned_eip1559(&Self::evm_tx(
            &p, p.nonce?,
        ))))
    }

    // ---------- internals ----------

    /// Validates and records a prepaid subscription. Errors are rejection reasons.
    fn subscribe(
        &mut self,
        customer: &AccountId,
        amount: U128,
        m: SubscribeMsg,
    ) -> Result<(), &'static str> {
        // `-<n>` is appended for issue orders, which must still be valid ids.
        if !valid_id(&m.subscription_id)
            || m.subscription_id.len() > MAX_ID_LEN - 4
            || !valid_id(&m.sku)
        {
            return Err("bad_id");
        }
        let product = match self.products.get(&m.sku) {
            Some(p) if p.active => p.clone(),
            _ => return Err("unknown_sku"),
        };
        let plan = match self.subscription_plans.get(&m.sku) {
            Some(p) if p.active => p.clone(),
            _ => return Err("no_subscription_plan"),
        };
        if m.issues < plan.min_issues || m.issues > plan.max_issues {
            return Err("issues_out_of_range");
        }
        if Some(amount.0) != product.price.0.checked_mul(m.issues as u128) {
            return Err("wrong_amount");
        }
        if self.subscriptions.contains_key(&m.subscription_id) {
            return Err("duplicate_subscription");
        }
        let now = env::block_timestamp();
        self.subscriptions.insert(
            m.subscription_id.clone(),
            Subscription {
                sku: m.sku.clone(),
                customer: customer.clone(),
                issue_price: product.price,
                issues_total: m.issues,
                issues_started: 0,
                interval_ns: plan.interval_ns,
                created_ns: now,
                next_due_ns: now,
                escrow: amount,
                state: SubscriptionState::Active,
                refund: None,
            },
        );
        emit(
            "subscription_started",
            serde_json::json!({
                "subscription_id": m.subscription_id, "sku": m.sku, "customer": customer, "amount": amount,
                "issues": m.issues, "issue_price": product.price, "interval_ns": plan.interval_ns,
            }),
        );
        Ok(())
    }

    fn send_subscription_refund(&self, subscription_id: &str, leg: &Leg) -> Promise {
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                leg.recipient.clone(),
                leg.amount,
                Some(format!("buffer:{subscription_id}:refund")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_subscription_refunded(subscription_id.to_string()),
            )
    }

    fn send_purchase(
        &self,
        order_id: &str,
        index: u32,
        vendor: &AccountId,
        amount: U128,
    ) -> Promise {
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                vendor.clone(),
                amount,
                Some(format!("buffer:{order_id}:purchase:{index}")),
            )
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
            .ft_transfer(
                leg.recipient.clone(),
                leg.amount,
                Some(format!("buffer:{order_id}:{leg_index}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_leg_resolved(order_id.to_string(), leg_index),
            )
    }

    fn evm_tx(p: &EvmPurchase, nonce: u64) -> evm::Erc20Transfer {
        evm::Erc20Transfer {
            chain_id: p.chain_id,
            nonce,
            max_priority_fee_per_gas: p.max_priority_fee_per_gas.0,
            max_fee_per_gas: p.max_fee_per_gas.0,
            gas_limit: p.gas_limit,
            token: evm::parse_address(&p.token).expect("stored token is valid"),
            to: evm::parse_address(&p.vendor).expect("stored vendor is valid"),
            amount: p.amount.0,
        }
    }

    /// Assigns the next treasury nonce, fixes the payload hash and asks the MPC network to sign it.
    fn start_signing(&mut self, order_id: &str, index: u32, cfg: &EvmConfig) -> Promise {
        let mut list = self
            .evm_purchases
            .get(order_id)
            .cloned()
            .expect("no evm purchases");
        let p = list.get_mut(index as usize).expect("no such evm purchase");
        let nonce = self.take_nonce(p.chain_id);
        let hash = env::keccak256(&evm::unsigned_eip1559(&Self::evm_tx(p, nonce)));
        let hash_hex = evm::to_hex(&hash);
        p.nonce = Some(nonce);
        p.payload_hash = Some(hash_hex.clone());
        self.evm_purchases.insert(order_id.to_string(), list);
        emit(
            "evm_signature_requested",
            serde_json::json!({ "order_id": order_id, "index": index, "nonce": nonce, "payload_hash": hash_hex }),
        );
        ext_mpc::ext(cfg.mpc_contract.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path: EVM_TREASURY_PATH.to_string(),
                payload_v2: MpcPayload::Ecdsa(hash_hex),
                domain_id: 0,
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGN_CALLBACK_GAS)
                    .on_evm_signed(order_id.to_string(), index),
            )
    }

    /// NEAR purchases plus cross-chain purchases that count against the cap.
    /// The original chain (`evm`) when `chain_id` is None or its id; otherwise an extra chain.
    fn chain_config(&self, chain_id: Option<u64>) -> EvmConfig {
        let original = self.evm.clone();
        match (chain_id, original) {
            (None, Some(c)) => c,
            (Some(id), Some(c)) if id == c.chain_id => c,
            (Some(id), _) => self
                .evm_chains
                .get(&id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("chain is not configured")),
            (None, None) => env::panic_str("cross-chain purchases are not configured"),
        }
    }

    fn is_original_chain(&self, chain_id: u64) -> bool {
        self.evm.as_ref().map(|c| c.chain_id) == Some(chain_id)
    }

    fn evm_vendor_approved(&self, chain_id: u64, vendor: &str) -> bool {
        if self.is_original_chain(chain_id) {
            self.evm_vendors.get(vendor).copied().unwrap_or(false)
        } else {
            self.evm_chain_vendors
                .get(&format!("{chain_id}:{vendor}"))
                .copied()
                .unwrap_or(false)
        }
    }

    fn take_nonce(&mut self, chain_id: u64) -> u64 {
        if self.is_original_chain(chain_id) {
            let n = self.evm_nonce;
            self.evm_nonce += 1;
            n
        } else {
            let n = self.evm_chain_nonces.get(&chain_id).copied().unwrap_or(0);
            self.evm_chain_nonces.insert(chain_id, n + 1);
            n
        }
    }

    /// Gives a nonce back if nothing was signed after it on that chain.
    fn give_back_nonce(&mut self, chain_id: u64, n: u64) {
        if self.is_original_chain(chain_id) {
            if self.evm_nonce == n + 1 {
                self.evm_nonce = n;
            }
        } else if self.evm_chain_nonces.get(&chain_id).copied() == Some(n + 1) {
            self.evm_chain_nonces.insert(chain_id, n);
        }
    }

    /// An order's expense cap: its quote's, or else its product's.
    fn expense_cap(&self, order_id: &str, order: &Order) -> u128 {
        match self.quotes.get(order_id) {
            Some(q) => q.max_expense.0,
            None => {
                self.products
                    .get(&order.sku)
                    .expect("product missing")
                    .max_expense
                    .0
            }
        }
    }

    fn committed_spend(&self, order_id: &str, order: &Order) -> u128 {
        let evm: u128 = self
            .evm_purchases
            .get(order_id)
            .map(|l| l.iter().filter(|p| p.committed()).map(|p| p.amount.0).sum())
            .unwrap_or(0);
        order.vendor_committed() + evm
    }

    fn evm_signed_total(&self, order_id: &str) -> u128 {
        self.evm_purchases
            .get(order_id)
            .map(|l| {
                l.iter()
                    .filter(|p| p.status == EvmPurchaseStatus::Signed)
                    .map(|p| p.amount.0)
                    .sum()
            })
            .unwrap_or(0)
    }

    fn order_or_panic(&self, order_id: &str) -> Order {
        self.orders
            .get(order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown order"))
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
        require!(
            self.contributor_bps as u128 <= BPS_DENOMINATOR,
            "contributor_bps out of range"
        );
        require!(
            self.contributor != self.agent && self.owner_payout != self.agent,
            "agent cannot be a revenue recipient"
        );
        require!(self.order_ttl_ns > 0, "order_ttl_ns must be positive");
    }
}

#[cfg(test)]
mod tests;
