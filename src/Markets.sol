// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUsdc} from "./IUsdc.sol";
import {CoinToken} from "./CoinToken.sol";

/// @title Markets — bonding-curve markets, priced and settled in USDC
///
/// @notice One contract holds every market. A market is a constant-product curve over a
///         virtual USDC reserve and a virtual token reserve; the contract custodies the
///         tokens it has not sold and the USDC it has taken in.
///
/// @dev Units. USDC on Arc exposes a 6-decimal ERC-20 view, and coins are minted with 6
///      decimals to match. Nothing in this contract scales between units.
///
/// @dev Fees. One percent of every trade, split 0.30% to the market's creator and 0.70%
///      to the protocol. On a buy the fee is taken from the input *before* the remainder
///      enters the reserve; on a sell it is taken from the output *after* it leaves.
///      That is what makes the solvency invariant hold exactly:
///
///          usdcBalance == Σ (reserveUsdc − VIRTUAL_USDC) + unclaimed creator and protocol fees
///
/// @dev Price impact. With fee-on-input the execution impact of a buy has a closed form:
///
///          effective price   = netIn / tokensOut
///          spot price        = reserveUsdc / reserveToken
///          impact            = netIn / reserveUsdc
///
///      so the ceiling is a single integer comparison rather than a square root. The sell
///      side is symmetric: impact = tokensIn / reserveToken.
contract Markets {
    // ─────────────────────────────────────────────────────────── constants

    IUsdc public constant USDC = IUsdc(0x3600000000000000000000000000000000000000);

    /// @dev Virtual USDC reserve every market starts with. Chosen so a 5 USDC buy on a
    ///      fresh market lands at 3.96% impact, comfortably under the 5% ceiling.
    uint256 public constant VIRTUAL_USDC = 125e6;
    /// @dev One billion coins, six decimals.
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000e6;

    uint256 public constant TOTAL_FEE_BPS = 100; // 1.00%
    uint256 public constant CREATOR_FEE_BPS = 30; // 0.30%
    uint256 public constant PROTOCOL_FEE_BPS = 70; // 0.70%
    uint256 public constant BPS = 10_000;

    uint256 public constant MAX_IMPACT_BPS = 500; // 5.00% hard ceiling
    uint256 public constant MIN_INITIAL_BUY = 1e6; // 1 USDC
    uint256 public constant MAX_TRADE = 5e6; // 5 USDC

    // ─────────────────────────────────────────────────────────── storage

    struct Market {
        CoinToken token;
        address creator;
        uint256 reserveUsdc; // virtual, starts at VIRTUAL_USDC
        uint256 reserveToken; // virtual, starts at TOKEN_SUPPLY
        uint256 creatorFees; // accrued, unclaimed
        uint64 createdAtBlock;
    }

    address public immutable treasury;

    Market[] internal _markets;
    uint256 public protocolFees;

    /// @notice Sum over all markets of (reserveUsdc − VIRTUAL_USDC). Tracked so the
    ///         solvency invariant is checkable in O(1) rather than by iterating markets.
    uint256 public totalCurveUsdc;

    // ─────────────────────────────────────────────────────────── events

    event MarketLaunched(
        uint256 indexed id,
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 initialBuy
    );
    event Bought(
        uint256 indexed id,
        address indexed buyer,
        uint256 usdcIn,
        uint256 tokensOut,
        uint256 impactBps,
        uint256 reserveUsdc,
        uint256 reserveToken
    );
    event Sold(
        uint256 indexed id,
        address indexed seller,
        uint256 tokensIn,
        uint256 usdcOut,
        uint256 impactBps,
        uint256 reserveUsdc,
        uint256 reserveToken
    );
    event CreatorFeesClaimed(uint256 indexed id, address indexed creator, uint256 amount);
    event ProtocolFeesClaimed(address indexed to, uint256 amount);

    // ─────────────────────────────────────────────────────────── errors

    error NoMarket();
    error BelowMinimumInitialBuy();
    error AboveMaxTrade();
    error ZeroAmount();
    error ImpactTooHigh(uint256 impactBps);
    error Slippage(uint256 got, uint256 wanted);
    error TransferFailed();
    error NotTreasury();
    error NothingToClaim();

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert NoMarket();
        treasury = treasury_;
    }

    // ─────────────────────────────────────────────────────────── views

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function markets(uint256 id)
        external
        view
        returns (
            address token,
            address creator,
            uint256 reserveUsdc,
            uint256 reserveToken,
            uint256 creatorFees,
            uint64 createdAtBlock
        )
    {
        Market storage m = _market(id);
        return
            (address(m.token), m.creator, m.reserveUsdc, m.reserveToken, m.creatorFees, m.createdAtBlock);
    }

    /// @notice Preview a buy without executing it.
    /// @return tokensOut   coins the buyer receives
    /// @return fee         total fee taken from `usdcIn`
    /// @return impactBps   execution impact in basis points
    function quoteBuy(uint256 id, uint256 usdcIn)
        public
        view
        returns (uint256 tokensOut, uint256 fee, uint256 impactBps)
    {
        Market storage m = _market(id);
        if (usdcIn == 0) revert ZeroAmount();
        fee = (usdcIn * TOTAL_FEE_BPS) / BPS;
        uint256 netIn = usdcIn - fee;
        tokensOut = (m.reserveToken * netIn) / (m.reserveUsdc + netIn);
        impactBps = (netIn * BPS) / m.reserveUsdc;
    }

    /// @notice Preview a sell without executing it.
    /// @return usdcOut     USDC the seller receives, after fee
    /// @return fee         total fee taken from the gross proceeds
    /// @return impactBps   execution impact in basis points
    function quoteSell(uint256 id, uint256 tokensIn)
        public
        view
        returns (uint256 usdcOut, uint256 fee, uint256 impactBps)
    {
        Market storage m = _market(id);
        if (tokensIn == 0) revert ZeroAmount();
        uint256 gross = (m.reserveUsdc * tokensIn) / (m.reserveToken + tokensIn);
        fee = (gross * TOTAL_FEE_BPS) / BPS;
        usdcOut = gross - fee;
        impactBps = (tokensIn * BPS) / m.reserveToken;
    }

    /// @notice The value the contract must be holding if its books are correct.
    /// @dev Compare against `USDC.balanceOf(address(this))`. Equality is the protocol's
    ///      solvency invariant; it is fuzz-tested rather than assumed.
    function expectedUsdcBalance() public view returns (uint256) {
        return totalCurveUsdc + protocolFees + _totalCreatorFees();
    }

    // ─────────────────────────────────────────────────────── state changing

    /// @notice Create a market and take its first position in one transaction.
    /// @dev The creator must have approved this contract for `initialBuy` USDC.
    function launch(string calldata name, string calldata symbol, uint256 initialBuy)
        external
        returns (uint256 id, uint256 tokensOut)
    {
        if (initialBuy < MIN_INITIAL_BUY) revert BelowMinimumInitialBuy();

        CoinToken token = new CoinToken(name, symbol, TOKEN_SUPPLY);
        id = _markets.length;
        _markets.push(
            Market({
                token: token,
                creator: msg.sender,
                reserveUsdc: VIRTUAL_USDC,
                reserveToken: TOKEN_SUPPLY,
                creatorFees: 0,
                createdAtBlock: uint64(block.number)
            })
        );

        emit MarketLaunched(id, address(token), msg.sender, name, symbol, initialBuy);
        tokensOut = _buy(id, initialBuy, 0);
    }

    /// @notice Spend `usdcIn` on market `id`, receiving at least `minTokensOut` coins.
    function buy(uint256 id, uint256 usdcIn, uint256 minTokensOut) external returns (uint256 tokensOut) {
        return _buy(id, usdcIn, minTokensOut);
    }

    /// @notice Sell `tokensIn` coins back to market `id` for at least `minUsdcOut` USDC.
    function sell(uint256 id, uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        Market storage m = _market(id);
        if (tokensIn == 0) revert ZeroAmount();

        uint256 impactBps = (tokensIn * BPS) / m.reserveToken;
        if (impactBps > MAX_IMPACT_BPS) revert ImpactTooHigh(impactBps);

        uint256 gross = (m.reserveUsdc * tokensIn) / (m.reserveToken + tokensIn);
        uint256 fee = (gross * TOTAL_FEE_BPS) / BPS;
        usdcOut = gross - fee;
        if (usdcOut < minUsdcOut) revert Slippage(usdcOut, minUsdcOut);

        if (!m.token.transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();

        m.reserveToken += tokensIn;
        m.reserveUsdc -= gross;
        totalCurveUsdc -= gross;
        _accrueFees(m, fee, msg.sender);

        if (!USDC.transfer(msg.sender, usdcOut)) revert TransferFailed();

        emit Sold(id, msg.sender, tokensIn, usdcOut, impactBps, m.reserveUsdc, m.reserveToken);
    }

    /// @notice Send a market's accrued creator fees to its creator.
    /// @dev Permissionless: anyone may trigger the payout, but it can only go to the
    ///      creator. That lets an agent's operator settle fees without the agent spending
    ///      gas on it.
    function claimCreatorFees(uint256 id) external returns (uint256 amount) {
        Market storage m = _market(id);
        amount = m.creatorFees;
        if (amount == 0) revert NothingToClaim();
        m.creatorFees = 0;
        if (!USDC.transfer(m.creator, amount)) revert TransferFailed();
        emit CreatorFeesClaimed(id, m.creator, amount);
    }

    function claimProtocolFees() external returns (uint256 amount) {
        if (msg.sender != treasury) revert NotTreasury();
        amount = protocolFees;
        if (amount == 0) revert NothingToClaim();
        protocolFees = 0;
        if (!USDC.transfer(treasury, amount)) revert TransferFailed();
        emit ProtocolFeesClaimed(treasury, amount);
    }

    // ─────────────────────────────────────────────────────────── internal

    function _buy(uint256 id, uint256 usdcIn, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        Market storage m = _market(id);
        if (usdcIn == 0) revert ZeroAmount();
        if (usdcIn > MAX_TRADE) revert AboveMaxTrade();

        uint256 fee = (usdcIn * TOTAL_FEE_BPS) / BPS;
        uint256 netIn = usdcIn - fee;

        uint256 impactBps = (netIn * BPS) / m.reserveUsdc;
        if (impactBps > MAX_IMPACT_BPS) revert ImpactTooHigh(impactBps);

        tokensOut = (m.reserveToken * netIn) / (m.reserveUsdc + netIn);
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);

        if (!USDC.transferFrom(msg.sender, address(this), usdcIn)) revert TransferFailed();

        m.reserveUsdc += netIn;
        m.reserveToken -= tokensOut;
        totalCurveUsdc += netIn;
        _accrueFees(m, fee, msg.sender);

        if (!m.token.transfer(msg.sender, tokensOut)) revert TransferFailed();

        emit Bought(id, msg.sender, usdcIn, tokensOut, impactBps, m.reserveUsdc, m.reserveToken);
    }

    /// @dev A creator earns nothing from trading its own market: that share goes to the
    ///      protocol instead. Without this, an agent could cycle its own coin and book
    ///      the fee as income.
    function _accrueFees(Market storage m, uint256 fee, address trader) internal {
        if (fee == 0) return;
        uint256 creatorCut = (fee * CREATOR_FEE_BPS) / TOTAL_FEE_BPS;
        if (trader == m.creator) {
            protocolFees += fee;
        } else {
            m.creatorFees += creatorCut;
            protocolFees += fee - creatorCut;
        }
    }

    function _market(uint256 id) internal view returns (Market storage m) {
        if (id >= _markets.length) revert NoMarket();
        m = _markets[id];
    }

    function _totalCreatorFees() internal view returns (uint256 sum) {
        uint256 n = _markets.length;
        for (uint256 i; i < n; ++i) {
            sum += _markets[i].creatorFees;
        }
    }
}
