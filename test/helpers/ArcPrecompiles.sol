// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

Vm constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// @notice Stand-in for Arc's native blocklist precompile at `0x1800..0001`.
/// @dev Arc stores the placeholder byte `0x01` at the precompile addresses and the
///      node intercepts calls to them. Foundry's local EVM does not intercept — it
///      executes `0x01` (ADD) against an empty stack and reverts with StackUnderflow.
contract BlocklistStub {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function isBlocklisted(address account) external view returns (bool) {
        return blocked[account];
    }
}

/// @notice Stand-in for Arc's native balance-transfer precompile at `0x1800..0000`.
/// @dev The USDC ERC-20 implementation converts the 6-decimal amount up to 18-decimal
///      native units and delegates the actual balance movement here. The stub performs
///      the move with `vm.deal` so fork tests can exercise real USDC flows.
contract NativeTransferStub {
    error InsufficientBalance();
    error Blocklisted(address account);

    /// @dev Arc enforces the blocklist at the value-transfer level, not only in the
    ///      ERC-20 layer: `USDC.transfer` reaches this precompile without consulting
    ///      the blocklist itself. The stub therefore has to check both parties, or
    ///      fork tests would let blocklisted transfers through.
    function transfer(address from, address to, uint256 amount18) external returns (bool) {
        BlocklistStub list = BlocklistStub(ArcPrecompiles.BLOCKLIST);
        if (list.isBlocklisted(from)) revert Blocklisted(from);
        if (list.isBlocklisted(to)) revert Blocklisted(to);

        if (from.balance < amount18) revert InsufficientBalance();
        VM.deal(from, from.balance - amount18);
        VM.deal(to, to.balance + amount18);
        return true;
    }
}

/// @notice Helpers for forking Arc Testnet in Foundry.
///
/// Usage:
///     ArcPrecompiles.installStubs();   // in setUp(), after createSelectFork
///
/// Without this, every USDC `transfer` / `transferFrom` reverts with StackUnderflow
/// and no USDC flow can be simulated against a fork.
library ArcPrecompiles {
    /// @dev USDC: upgradeable proxy, ERC-20 view with 6 decimals.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    /// @dev Native balance transfer, called with 18-decimal amounts.
    address internal constant NATIVE_TRANSFER = 0x1800000000000000000000000000000000000000;
    /// @dev Blocklist check, consulted on every transfer.
    address internal constant BLOCKLIST = 0x1800000000000000000000000000000000000001;

    uint256 internal constant CHAIN_ID = 5042002;

    function installStubs() internal returns (BlocklistStub blocklist) {
        BlocklistStub b = new BlocklistStub();
        NativeTransferStub n = new NativeTransferStub();

        VM.etch(BLOCKLIST, address(b).code);
        VM.etch(NATIVE_TRANSFER, address(n).code);
        // The transfer stub moves balances with `vm.deal`, so the etched address
        // needs cheatcode access.
        VM.allowCheatcodes(NATIVE_TRANSFER);

        VM.label(BLOCKLIST, "ArcBlocklistPrecompile");
        VM.label(NATIVE_TRANSFER, "ArcNativeTransferPrecompile");
        VM.label(USDC, "USDC");

        return BlocklistStub(BLOCKLIST);
    }
}
