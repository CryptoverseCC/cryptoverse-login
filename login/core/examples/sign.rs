//! Dev helper: sign a message (read from stdin) with an EIP-191 personal_sign,
//! using a private key passed as the first argument. Prints the `0x` signature
//! on stdout and the signer's checksummed address on stderr.
//!
//! Used by the local `podman kube play` smoke test to produce a SIWE signature
//! without a browser/wallet. Not part of the shipped services.
//!
//!   echo -n "<siwe message>" | cargo run -p cryptoverse-core --example sign -- 0x<privkey>

use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;
use std::io::Read;

fn main() {
    let key = std::env::args()
        .nth(1)
        .expect("usage: sign <private-key-hex>  (message on stdin)");

    let mut message = String::new();
    std::io::stdin()
        .read_to_string(&mut message)
        .expect("read stdin");

    let signer: PrivateKeySigner = key.parse().expect("invalid private key");
    let sig = signer
        .sign_message_sync(message.as_bytes())
        .expect("signing failed");

    println!("0x{}", hex::encode(sig.as_bytes()));
    eprintln!("{}", signer.address().to_checksum(None));
}
