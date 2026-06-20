//! Shared building blocks for the Cryptoverse Login services.
//!
//! Both the `login` (Hydra login & consent provider) and `wrapper` binaries
//! depend on this crate. It contains the Hydra admin client, the EIP-4361
//! (Sign-In with Ethereum) verification logic, on-chain helpers (ENS /
//! Unstoppable Domains / ERC-20 balances), and shared config + telemetry.

pub mod auth;
pub mod config;
pub mod eth;
pub mod hydra;
pub mod telemetry;
