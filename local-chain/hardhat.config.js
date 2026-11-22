/** Local devnet for the Oorka demo. Same mnemonic and chain id as anvil, so the frontend's local mode works as-is. */
module.exports = {
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun", // v4 uses transient storage (EIP-1153)
      allowUnlimitedContractSize: true, // PoolManager test builds can exceed 24 KB
      blockGasLimit: 60_000_000,
      accounts: { mnemonic: "test test test test test test test test test test test junk", count: 10, accountsBalance: "10000000000000000000000" },
      mining: { auto: true },
    },
  },
};
