// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface of USDC on Arc.
/// @dev On Arc, USDC is a single asset exposed through two interfaces:
///      - native, 18 decimals, used for gas and `msg.value`
///      - ERC-20 at 0x3600...0000, 6 decimals, used for application transfers
///      They share the same underlying balance. Contracts use this interface.
interface IUsdc {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
