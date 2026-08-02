// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CoinToken — the token behind one market
/// @notice Fixed supply, minted once to the market that created it. The market holds
///         every token it has not sold, so there is no mint or burn path after launch.
/// @dev Six decimals, matching USDC on Arc. Every amount in the protocol — collateral,
///      fees, reserves, token balances — is therefore in the same base unit, and the
///      curve performs no scaling at all.
contract CoinToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;

    uint256 public immutable totalSupply;
    address public immutable market;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint256 supply) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply;
        market = msg.sender;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != from) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) {
                if (allowed < amount) revert InsufficientAllowance();
                unchecked {
                    allowance[from][msg.sender] = allowed - amount;
                }
            }
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        // Arc rejects transfers to the zero address for USDC; we mirror that here so a
        // coin cannot be accidentally burned out of the curve's accounting.
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
