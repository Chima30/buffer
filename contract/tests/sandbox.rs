//! Sandbox integration test: builds the wasm, deploys it to a local NEAR
//! sandbox and checks initialisation, owner-only configuration and views.
//! Run on your machine with `cargo test --test sandbox` (needs the wasm32
//! target and downloads the sandbox binary on first run).

use near_api::{AccountId, NearToken};
use near_sdk::serde_json::{Value, json};

async fn create_account(sandbox: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<near_api::Account> {
    let id: AccountId = name.parse()?;
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(10)).send().await?;
    Ok(near_api::Account(id))
}

#[tokio::test]
async fn deploys_and_enforces_owner_only_config() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let owner = create_account(&sandbox, "owner.sandbox").await?;
    let agent = create_account(&sandbox, "agent.sandbox").await?;
    let contract = create_account(&sandbox, "desk.sandbox").await?.as_contract();

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call(
            "new",
            json!({
                "owner": owner.account_id(),
                "agent": agent.account_id(),
                "token_id": "usdc.sandbox",
                "owner_payout": "payout.sandbox",
                "contributor": "contrib.sandbox",
                "contributor_bps": 3000,
                "purchase_approval_above": "10000000",
                "order_ttl_ns": 3_600_000_000_000u64,
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    contract
        .call_function("set_product", json!({ "sku": "weekly-market-brief", "price": "20000000", "max_expense": "13000000", "active": true }))
        .transaction()
        .with_signer(owner.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // The agent cannot change the revenue split.
    contract
        .call_function("set_recipients", json!({ "owner_payout": "payout.sandbox", "contributor": "evil.sandbox", "contributor_bps": 9000 }))
        .transaction()
        .with_signer(agent.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    let config: Value = contract.call_function("get_config", ()).read_only().fetch_from(&net).await?.data;
    assert_eq!(config["contributor_bps"], 3000);
    assert_eq!(config["contributor"], "contrib.sandbox");
    assert_eq!(config["paused"], false);
    Ok(())
}
