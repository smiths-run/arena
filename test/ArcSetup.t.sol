// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IUsdc} from "../src/IUsdc.sol";
import {ArcPrecompiles, BlocklistStub} from "./helpers/ArcPrecompiles.sol";

/// @notice Verifies the Arc fork environment every other test depends on.
///
///     export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io
///     forge test --match-contract ArcSetupTest -vv
///
/// Needs an RPC URL only — no private key, no funds.
contract ArcSetupTest is Test {
    IUsdc internal usdc = IUsdc(ArcPrecompiles.USDC);
    BlocklistStub internal blocklist;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant ONE_USDC = 1e6;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("ARC_TESTNET_RPC_URL not set - skipping");
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        blocklist = ArcPrecompiles.installStubs();
    }

    function test_ChainAndToken() public view {
        assertEq(block.chainid, ArcPrecompiles.CHAIN_ID, "chain id");
        assertEq(usdc.decimals(), 6, "USDC exposes 6 decimals through ERC-20");
        assertEq(block.prevrandao, 0, "no onchain randomness on Arc");
    }

    /// @dev USDC is one balance behind two interfaces: 18-decimal native for gas,
    ///      6-decimal ERC-20 for application transfers.
    function test_NativeAndErc20AreOneBalance() public {
        vm.deal(alice, 1e18);
        assertEq(usdc.balanceOf(alice), ONE_USDC, "same balance, 6-decimal view");
    }

    /// @dev The 6-decimal view drops anything below 1e12 wei, so a non-zero account
    ///      can read as empty. Balance checks must never rely on this alone.
    function test_Erc20ViewTruncates() public {
        vm.deal(alice, 999_999_999_999);
        assertEq(usdc.balanceOf(alice), 0, "reads as zero");
        assertGt(alice.balance, 0, "but is not empty");
    }

    function test_TransfersWork() public {
        vm.deal(alice, 5e18);

        vm.prank(alice);
        assertTrue(usdc.transfer(bob, 2 * ONE_USDC), "transfer");

        assertEq(usdc.balanceOf(bob), 2 * ONE_USDC, "recipient credited");
        assertEq(usdc.balanceOf(alice), 3 * ONE_USDC, "sender debited");
    }

    /// @dev Transfers to or from a blocklisted address revert inside USDC. Reachable
    ///      only because the stub is settable; worth covering as its own error class.
    function test_BlocklistedTransferReverts() public {
        vm.deal(alice, 5e18);
        blocklist.setBlocked(bob, true);

        vm.prank(alice);
        vm.expectRevert();
        usdc.transfer(bob, ONE_USDC);
    }

    function testFuzz_TransferConservesTotal(uint96 amount) public {
        amount = uint96(bound(amount, 1, 100 * ONE_USDC));
        vm.deal(alice, uint256(amount) * 1e12);

        uint256 before = usdc.balanceOf(alice) + usdc.balanceOf(bob);

        vm.prank(alice);
        usdc.transfer(bob, amount);

        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob), before, "no value created or lost");
    }
}
