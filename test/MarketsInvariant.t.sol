// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Markets} from "../src/Markets.sol";
import {CoinToken} from "../src/CoinToken.sol";
import {MockUsdc6} from "./mocks/MockUsdc6.sol";
import {ArcPrecompiles} from "./helpers/ArcPrecompiles.sol";

/// @notice Drives Markets with bounded random activity from several actors.
/// @dev Every entry point clamps its inputs to something the protocol would accept, so
///      the fuzzer spends its runs exploring real sequences rather than reverting.
contract Handler is Test {
    Markets public mk;
    MockUsdc6 public usdc;

    address[] public actors;
    uint256 public launches;
    uint256 public buys;
    uint256 public sells;
    uint256 public claims;
    uint256 public donatedUsdc;
    uint256 public donatedTokens;

    constructor(Markets mk_, MockUsdc6 usdc_, address[] memory actors_) {
        mk = mk_;
        usdc = usdc_;
        actors = actors_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _marketId(uint256 seed) internal view returns (uint256) {
        return seed % mk.marketCount();
    }

    function launch(uint256 actorSeed, uint256 amount) external {
        if (mk.marketCount() >= 8) return; // keep the state space walkable
        address a = _actor(actorSeed);
        uint256 initial = bound(amount, mk.MIN_INITIAL_BUY(), mk.MAX_TRADE());
        if (usdc.balanceOf(a) < initial) return;

        vm.prank(a);
        mk.launch("Coin", "COIN", initial);
        launches++;
    }

    function buy(uint256 marketSeed, uint256 actorSeed, uint256 amount) external {
        if (mk.marketCount() == 0) return;
        uint256 id = _marketId(marketSeed);
        address a = _actor(actorSeed);
        uint256 usdcIn = bound(amount, 1, mk.MAX_TRADE());
        if (usdc.balanceOf(a) < usdcIn) return;

        // Respect the impact ceiling rather than reverting against it.
        (,, uint256 rU,,,) = mk.markets(id);
        uint256 maxNet = (rU * mk.MAX_IMPACT_BPS()) / mk.BPS();
        uint256 maxIn = (maxNet * mk.BPS()) / (mk.BPS() - mk.TOTAL_FEE_BPS());
        if (usdcIn > maxIn) usdcIn = maxIn;
        if (usdcIn == 0) return;

        vm.prank(a);
        mk.buy(id, usdcIn, 0);
        buys++;
    }

    function sell(uint256 marketSeed, uint256 actorSeed, uint256 amount) external {
        uint256 n = mk.marketCount();
        if (n == 0) return;
        address a = _actor(actorSeed);

        // Start from the seeded market, then walk until we find one this actor actually
        // holds. Picking blindly leaves the sell path barely exercised.
        uint256 id = type(uint256).max;
        for (uint256 k; k < n; ++k) {
            uint256 candidate = (marketSeed % n + k) % n; // reduce first; marketSeed can be near max
            (address ct,,,,,) = mk.markets(candidate);
            if (CoinToken(ct).balanceOf(a) > 0) {
                id = candidate;
                break;
            }
        }
        if (id == type(uint256).max) return;

        (address t,,, uint256 rT,,) = mk.markets(id);
        CoinToken token = CoinToken(t);
        uint256 held = token.balanceOf(a);
        if (held == 0) return;

        // Sell a percentage of the holding rather than a raw amount: a uniform draw
        // over [1, held] is dust almost every time, and dust sales quote to zero.
        uint256 cap = (rT * mk.MAX_IMPACT_BPS()) / mk.BPS();
        uint256 pct = bound(amount, 1, 100);
        uint256 tokensIn = (held * pct) / 100;
        if (tokensIn > cap) tokensIn = cap;
        if (tokensIn == 0) return;

        (uint256 out,,) = mk.quoteSell(id, tokensIn);
        if (out == 0) return; // dust sale, nothing to settle

        vm.startPrank(a);
        token.approve(address(mk), tokensIn);
        mk.sell(id, tokensIn, 0);
        vm.stopPrank();
        sells++;
    }

    function claimCreator(uint256 marketSeed) external {
        if (mk.marketCount() == 0) return;
        uint256 id = _marketId(marketSeed);
        (,,,, uint256 fees,) = mk.markets(id);
        if (fees == 0) return;
        mk.claimCreatorFees(id);
        claims++;
    }

    /**
     * Anyone can push USDC or a coin straight at the contract. Nothing in the
     * protocol invites it, which is exactly why the invariants have to survive
     * it: an equality that a stranger can break with a transfer is not a
     * solvency property, it is a coincidence.
     */
    function donateUsdc(uint256 amount) external {
        uint256 gift = bound(amount, 1, 5e6);
        address a = _actor(gift);
        if (usdc.balanceOf(a) < gift) return;
        vm.prank(a);
        usdc.transfer(address(mk), gift);
        donatedUsdc += gift;
    }

    function donateTokens(uint256 marketSeed, uint256 actorSeed, uint256 amount) external {
        uint256 n = mk.marketCount();
        if (n == 0) return;
        address a = _actor(actorSeed);
        uint256 id = marketSeed % n;
        (address t,,,,,) = mk.markets(id);
        CoinToken token = CoinToken(t);
        uint256 held = token.balanceOf(a);
        if (held == 0) return;
        uint256 gift = bound(amount, 1, held);
        vm.prank(a);
        token.transfer(address(mk), gift);
        donatedTokens++;
    }

    function claimProtocol() external {
        if (mk.protocolFees() == 0) return;
        vm.prank(mk.treasury());
        mk.claimProtocolFees();
        claims++;
    }
}

/// @notice The gate for the market contract: the books must balance after any sequence
///         of launches, trades and claims.
contract MarketsInvariantTest is Test {
    Markets internal mk;
    MockUsdc6 internal usdc;
    Handler internal handler;

    address internal treasury = makeAddr("treasury");

    function setUp() public {
        MockUsdc6 impl = new MockUsdc6();
        vm.etch(ArcPrecompiles.USDC, address(impl).code);
        usdc = MockUsdc6(ArcPrecompiles.USDC);

        mk = new Markets(treasury);

        address[] memory actors = new address[](4);
        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            usdc.mint(actors[i], 10_000e6);
            vm.prank(actors[i]);
            usdc.approve(address(mk), type(uint256).max);
        }

        handler = new Handler(mk, usdc, actors);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.launch.selector;
        selectors[1] = Handler.buy.selector;
        selectors[2] = Handler.sell.selector;
        selectors[3] = Handler.claimCreator.selector;
        selectors[4] = Handler.claimProtocol.selector;
        selectors[5] = Handler.donateUsdc.selector;
        selectors[6] = Handler.donateTokens.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

        // Seed one market so trading is reachable from the first call.
        vm.prank(actors[0]);
        mk.launch("Genesis", "GEN", 1e6);
    }

    /// @notice Solvency. The contract must hold at least what it owes — curve
    ///         reserves plus every fee nobody has claimed yet.
    /// @dev Deliberately `>=` rather than `==`. Anyone can transfer USDC straight to
    ///      the contract, and an equality that a stranger can break by being generous
    ///      is not a solvency property. What matters is that the books are never
    ///      short; surplus is tracked separately below.
    function invariant_UsdcCoversLiabilities() public view {
        assertGe(
            usdc.balanceOf(address(mk)),
            mk.expectedUsdcBalance(),
            "usdc held must cover curve reserves plus unclaimed fees"
        );
    }

    /// @notice Any surplus is exactly what was donated — the protocol itself never
    ///         creates or loses a unit it has not accounted for.
    function invariant_SurplusIsOnlyDonations() public view {
        uint256 held = usdc.balanceOf(address(mk));
        uint256 owed = mk.expectedUsdcBalance();
        assertEq(held - owed, handler.donatedUsdc(), "unexplained surplus or shortfall");
    }

    /// @notice The constant product of every curve is non-decreasing.
    /// @dev The strongest economic statement available here: k is preserved exactly in
    ///      real arithmetic and rounding only ever pushes it up, so the reserve can
    ///      always honour the coins outstanding against it. A leak would show as k
    ///      falling below where the curve started.
    function invariant_ConstantProductNeverFalls() public view {
        uint256 n = mk.marketCount();
        uint256 floorK = mk.VIRTUAL_USDC() * mk.TOKEN_SUPPLY();
        for (uint256 i; i < n; ++i) {
            (,, uint256 rU, uint256 rT,,) = mk.markets(i);
            assertGe(rU * rT, floorK, "constant product fell below its starting value");
        }
    }

    /// @notice The contract really holds every coin it has not sold.
    /// @dev `>=` for the same reason as the USDC invariant: anyone can transfer a coin
    ///      to the market address, and that must not be able to falsify solvency.
    function invariant_TokenReserveIsBacked() public view {
        uint256 n = mk.marketCount();
        for (uint256 i; i < n; ++i) {
            (address t,,, uint256 rT,,) = mk.markets(i);
            assertGe(
                CoinToken(t).balanceOf(address(mk)),
                rT,
                "token reserve must be backed by the real balance"
            );
        }
    }

    /// @notice A curve can never be drained below the virtual floor it started from.
    function invariant_ReserveNeverFallsBelowVirtualFloor() public view {
        uint256 n = mk.marketCount();
        for (uint256 i; i < n; ++i) {
            (,, uint256 rU,,,) = mk.markets(i);
            assertGe(rU, mk.VIRTUAL_USDC(), "reserve below the virtual floor");
        }
    }

    function invariant_CallSummary() public view {
        console2.log("launches", handler.launches());
        console2.log("buys    ", handler.buys());
        console2.log("sells   ", handler.sells());
        console2.log("claims  ", handler.claims());
        console2.log("donations", handler.donatedUsdc());
    }
}
