import json, sys, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(root, "contracts", "out")
dst = os.path.join(root, "frontend", "src", "abi")
for path, name in [("OorkaHook.sol/OorkaHook.json","OorkaHook"),("PoolSwapTest.sol/PoolSwapTest.json","PoolSwapTest"),("MockERC20.sol/MockERC20.json","MockERC20")]:
    abi = json.load(open(os.path.join(out, path)))["abi"]
    json.dump(abi, open(os.path.join(dst, name + ".json"), "w"))
    print("exported", name)
