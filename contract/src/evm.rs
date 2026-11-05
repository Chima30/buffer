//! Minimal EIP-1559 transaction builder for one shape only: an ERC-20
//! `transfer(to, amount)` call. The contract builds the bytes itself so the
//! agent never chooses what gets signed. Verified against viem vectors in tests.

/// Parses "0x" + 40 hex chars (any case) into 20 bytes.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x")?;
    if h.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

pub fn to_hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    s
}

/// Lowercase "0x…" form, the canonical key for the vendor allowlist.
pub fn address_string(a: &[u8; 20]) -> String {
    format!("0x{}", to_hex(a))
}

fn be_trimmed(v: u128) -> Vec<u8> {
    let b = v.to_be_bytes();
    let first = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[first..].to_vec()
}

fn length_prefix(len: usize, short: u8, out: &mut Vec<u8>) {
    if len < 56 {
        out.push(short + len as u8);
    } else {
        let l = be_trimmed(len as u128);
        out.push(short + 55 + l.len() as u8);
        out.extend_from_slice(&l);
    }
}

fn rlp_bytes(b: &[u8], out: &mut Vec<u8>) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        length_prefix(b.len(), 0x80, out);
        out.extend_from_slice(b);
    }
}

fn rlp_uint(v: u128, out: &mut Vec<u8>) {
    rlp_bytes(&be_trimmed(v), out);
}

fn rlp_list(items: &[u8], out: &mut Vec<u8>) {
    length_prefix(items.len(), 0xc0, out);
    out.extend_from_slice(items);
}

/// ABI calldata for `transfer(address,uint256)`.
pub fn erc20_transfer_data(to: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut d = vec![0xa9, 0x05, 0x9c, 0xbb];
    d.extend_from_slice(&[0u8; 12]);
    d.extend_from_slice(to);
    d.extend_from_slice(&[0u8; 16]);
    d.extend_from_slice(&amount.to_be_bytes());
    d
}

pub struct Erc20Transfer {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub token: [u8; 20],
    pub to: [u8; 20],
    pub amount: u128,
}

/// Unsigned EIP-1559 transaction bytes: 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, accessList]).
/// Its keccak256 is what the MPC network signs.
pub fn unsigned_eip1559(t: &Erc20Transfer) -> Vec<u8> {
    let mut items = Vec::with_capacity(128);
    rlp_uint(t.chain_id as u128, &mut items);
    rlp_uint(t.nonce as u128, &mut items);
    rlp_uint(t.max_priority_fee_per_gas, &mut items);
    rlp_uint(t.max_fee_per_gas, &mut items);
    rlp_uint(t.gas_limit as u128, &mut items);
    rlp_bytes(&t.token, &mut items);
    rlp_uint(0, &mut items); // value: no ETH moves
    rlp_bytes(&erc20_transfer_data(&t.to, t.amount), &mut items);
    rlp_list(&[], &mut items); // empty access list
    let mut out = vec![0x02];
    rlp_list(&items, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: &str = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    const VENDOR: &str = "0x00000000000000000000000000000000000000aa";

    fn tx(nonce: u64, prio: u128, fee: u128) -> Erc20Transfer {
        Erc20Transfer {
            chain_id: 11155111,
            nonce,
            max_priority_fee_per_gas: prio,
            max_fee_per_gas: fee,
            gas_limit: 100_000,
            token: parse_address(USDC).unwrap(),
            to: parse_address(VENDOR).unwrap(),
            amount: 12_000_000,
        }
    }

    // Expected values produced by viem serializeTransaction / keccak256.
    #[test]
    fn matches_viem_vectors() {
        let cases = [
            (
                0,
                1_000_000_000,
                30_000_000_000,
                "02f87183aa36a780843b9aca008506fc23ac00830186a0941c7d4b196cb0c7b01d743fbc6116a902379c723880b844a9059cbb00000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000b71b00c0",
                "71f556309451a20381752b4e152c7eb1625ef48967c06977969393933b6f7714",
            ),
            (
                7,
                0,
                1,
                "02f86883aa36a7078001830186a0941c7d4b196cb0c7b01d743fbc6116a902379c723880b844a9059cbb00000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000b71b00c0",
                "62f810ab25c4e4cd4147dc10db5dca6d72f6e7ecc3aace04ce6035294814c76b",
            ),
            (
                300,
                1_500_000_000,
                200_000_000_000,
                "02f87383aa36a782012c8459682f00852e90edd000830186a0941c7d4b196cb0c7b01d743fbc6116a902379c723880b844a9059cbb00000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000b71b00c0",
                "9026d3baf3cb9f4d9979d69855a9058dfaed49ad5726ed0ca49b2811bf0694ac",
            ),
        ];
        for (nonce, prio, fee, bytes, hash) in cases {
            let b = unsigned_eip1559(&tx(nonce, prio, fee));
            assert_eq!(to_hex(&b), bytes);
            assert_eq!(to_hex(&near_sdk::env::keccak256(&b)), hash);
        }
    }

    #[test]
    fn parses_addresses() {
        assert_eq!(
            address_string(&parse_address(USDC).unwrap()),
            USDC.to_lowercase()
        );
        assert!(parse_address("0x123").is_none());
        assert!(parse_address("1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").is_none());
        assert!(parse_address("0xzz7D4B196Cb0C7B01d743Fbc6116a902379C7238").is_none());
    }
}
