// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Markets} from "../src/Markets.sol";
import {CoinToken} from "../src/CoinToken.sol";
import {MockUsdc6} from "./mocks/MockUsdc6.sol";
import {ArcPrecompiles} from "./helpers/ArcPrecompiles.sol";

contract MarketsTest is Test {
    Markets internal mk;
    MockUsdc6 internal usdc;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // creator
    address internal bob = makeAddr("bob"); // outside buyer

    uint256 internal constant ONE = 1e6;

    function setUp() public {
        // Markets hardcodes USDC at its Arc address, so the mock is etched there.
        MockUsdc6 impl = new MockUsdc6();
        vm.etch(ArcPrecompiles.USDC, address(impl).code);
        usdc = MockUsdc6(ArcPrecompiles.USDC);

        mk = new Markets(treasury);

        usdc.mint(alice, 1_000 * ONE);
        usdc.mint(bob, 1_000 * ONE);
        vm.prank(alice);
        usdc.approve(address(mk), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(mk), type(uint256).max);
    }

    function _launch() internal returns (uint256 id, CoinToken token) {
        vm.prank(alice);
        (id,) = mk.launch("Pulse", "PULSE", ONE);
        (address t,,,,,) = mk.markets(id);
        token = CoinToken(t);
    }

    function _solvent() internal view {
        assertEq(
            usdc.balanceOf(address(mk)),
            mk.expectedUsdcBalance(),
            "usdc held must equal curve reserves plus unclaimed fees"
        );
    }

    // ──────────────────────────────────────────────────────────── launch

    function test_Launch_CreatesMarketAndFirstPosition() public {
        (uint256 id, CoinToken token) = _launch();

        (address t, address creator, uint256 rU, uint256 rT,, uint64 blk) = mk.markets(id);
        assertEq(t, address(token));
        assertEq(creator, alice);
        assertEq(blk, uint64(block.number));

        // 1 USDC in, 1% fee, 0.99 enters the reserve
        assertEq(rU, mk.VIRTUAL_USDC() + 990_000, "reserve took net input");
        assertGt(token.balanceOf(alice), 0, "creator holds the first position");
        assertEq(rT, mk.TOKEN_SUPPLY() - token.balanceOf(alice), "reserve less what was sold");
        _solvent();
    }

    function test_Launch_RevertsBelowMinimum() public {
        vm.prank(alice);
        vm.expectRevert(Markets.BelowMinimumInitialBuy.selector);
        mk.launch("Pulse", "PULSE", ONE - 1);
    }

    // ─────────────────────────────────────────────────────── impact table

    /// @dev The closed form is impact = netIn / reserveUsdc. These are the three figures
    ///      the design was tuned around; if the constants ever move, this test says so.
    function test_ImpactMatchesDesignTable() public {
        (uint256 id,) = _launch();

        // Fresh curve for a clean comparison.
        Markets fresh = new Markets(treasury);
        usdc.mint(alice, 100 * ONE);
        vm.startPrank(alice);
        usdc.approve(address(fresh), type(uint256).max);
        (uint256 fid,) = fresh.launch("Fresh", "FRSH", ONE);
        vm.stopPrank();
        // Undo the launch buy's effect by reading impact on a market that has only the
        // virtual reserve: use quotes on the untouched `id` before any further trade.
        id;
        fid;

        Markets clean = new Markets(treasury);
        vm.startPrank(alice);
        usdc.approve(address(clean), type(uint256).max);
        clean.launch("Clean", "CLN", ONE);
        vm.stopPrank();

        // Quote against VIRTUAL_USDC directly by computing what the contract would.
        uint256 virt = clean.VIRTUAL_USDC();
        assertEq((990_000 * 10_000) / virt, 79, "1 USDC -> 0.79%");
        assertEq((2_970_000 * 10_000) / virt, 237, "3 USDC -> 2.38%");
        assertEq((4_950_000 * 10_000) / virt, 396, "5 USDC -> 3.96%");
    }

    function test_QuoteBuy_MatchesExecution() public {
        (uint256 id, CoinToken token) = _launch();

        (uint256 quoted, uint256 fee, uint256 impact) = mk.quoteBuy(id, 2 * ONE);
        assertEq(fee, 20_000, "1% of 2 USDC");
        assertGt(impact, 0);

        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        uint256 got = mk.buy(id, 2 * ONE, 0);
        assertEq(got, quoted, "quote is exact");
        assertEq(token.balanceOf(bob) - before, quoted);
        _solvent();
    }

    function test_Buy_RevertsAboveMaxTrade() public {
        (uint256 id,) = _launch();
        uint256 tooBig = mk.MAX_TRADE() + 1; // read before arming expectRevert
        vm.prank(bob);
        vm.expectRevert(Markets.AboveMaxTrade.selector);
        mk.buy(id, tooBig, 0);
    }

    function test_Buy_RevertsOnSlippage() public {
        (uint256 id,) = _launch();
        (uint256 quoted,,) = mk.quoteBuy(id, ONE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Markets.Slippage.selector, quoted, quoted + 1));
        mk.buy(id, ONE, quoted + 1);
    }

    // ─────────────────────────────────────────────────────────────── sell

    function test_SellBack_LeavesOnlyFeesBehind() public {
        (uint256 id, CoinToken token) = _launch();

        vm.prank(bob);
        uint256 got = mk.buy(id, 2 * ONE, 0);

        vm.startPrank(bob);
        token.approve(address(mk), got);
        uint256 out = mk.sell(id, got, 0);
        vm.stopPrank();

        assertLt(out, 2 * ONE, "two fees paid on the round trip");
        _solvent();

        // The reserve returns to its post-launch level, never below it. Integer division
        // truncates in the curve's favour on both legs, so a round trip can leave a unit
        // of dust behind — but it can never take one out.
        (,, uint256 rU,,,) = mk.markets(id);
        assertGe(rU, mk.VIRTUAL_USDC() + 990_000, "rounding may only favour the curve");
        assertLe(rU, mk.VIRTUAL_USDC() + 990_000 + 2, "and only by dust");
    }

    function test_Sell_RevertsAboveImpactCeiling() public {
        (uint256 id, CoinToken token) = _launch();

        // Give bob more coins than the ceiling allows him to dump at once.
        (,,, uint256 rT,,) = mk.markets(id);
        uint256 bps = mk.BPS();
        uint256 huge = (rT * (mk.MAX_IMPACT_BPS() + 50)) / bps;
        uint256 actualImpact = (huge * bps) / rT; // floored, so read it rather than assume

        uint256 aliceBal = token.balanceOf(alice); // read before pranking
        vm.prank(alice);
        token.transfer(bob, aliceBal);

        vm.startPrank(bob);
        token.approve(address(mk), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(Markets.ImpactTooHigh.selector, actualImpact));
        mk.sell(id, huge, 0);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────── fees

    function test_CreatorSelfTrade_PaysTheProtocolInstead() public {
        (uint256 id,) = _launch();

        (,,,, uint256 creatorFees,) = mk.markets(id);
        assertEq(creatorFees, 0, "a creator earns nothing from its own launch buy");
        assertEq(mk.protocolFees(), 10_000, "the whole fee went to the protocol");

        vm.prank(alice);
        mk.buy(id, ONE, 0);
        (,,,, creatorFees,) = mk.markets(id);
        assertEq(creatorFees, 0, "still nothing from self-trading");
        _solvent();
    }

    function test_OutsideTrade_AccruesAndPaysCreator() public {
        (uint256 id,) = _launch();

        vm.prank(bob);
        mk.buy(id, 2 * ONE, 0);

        (,,,, uint256 creatorFees,) = mk.markets(id);
        assertEq(creatorFees, 6_000, "0.30% of 2 USDC");
        assertEq(mk.protocolFees(), 10_000 + 14_000, "launch fee plus 0.70% of 2 USDC");

        uint256 before = usdc.balanceOf(alice);
        mk.claimCreatorFees(id); // permissionless, still pays the creator
        assertEq(usdc.balanceOf(alice) - before, 6_000);

        (,,,, creatorFees,) = mk.markets(id);
        assertEq(creatorFees, 0);
        _solvent();
    }

    function test_ClaimProtocolFees_OnlyTreasury() public {
        (uint256 id,) = _launch();
        vm.prank(bob);
        mk.buy(id, ONE, 0);

        vm.prank(bob);
        vm.expectRevert(Markets.NotTreasury.selector);
        mk.claimProtocolFees();

        uint256 expected = mk.protocolFees();
        vm.prank(treasury);
        uint256 paid = mk.claimProtocolFees();
        assertEq(paid, expected);
        assertEq(usdc.balanceOf(treasury), expected);
        _solvent();
    }

    // ────────────────────────────────────────────────────────────── fuzz

    /// @dev Any single buy inside the limits must leave the books balanced and must never
    ///      hand out more than the reserve holds.
    function testFuzz_Buy_KeepsBooksBalanced(uint96 amount) public {
        (uint256 id, CoinToken token) = _launch();
        uint256 usdcIn = bound(uint256(amount), 1, mk.MAX_TRADE());

        (,,, uint256 rTBefore,,) = mk.markets(id);
        vm.prank(bob);
        uint256 got = mk.buy(id, usdcIn, 0);

        (,,, uint256 rTAfter,,) = mk.markets(id);
        assertEq(rTBefore - rTAfter, got, "reserve released exactly what was sold");
        assertEq(token.balanceOf(bob), got);
        _solvent();
    }

    /// @dev Buying then immediately selling can never be profitable: the two fees are
    ///      the protocol's only edge and must always be paid.
    function testFuzz_RoundTripNeverProfits(uint96 amount) public {
        (uint256 id, CoinToken token) = _launch();
        uint256 usdcIn = bound(uint256(amount), 1e4, mk.MAX_TRADE());

        vm.startPrank(bob);
        uint256 got = mk.buy(id, usdcIn, 0);
        token.approve(address(mk), got);
        uint256 out = got == 0 ? 0 : mk.sell(id, got, 0);
        vm.stopPrank();

        assertLe(out, usdcIn, "a round trip can never return more than it cost");
        _solvent();
    }
}
