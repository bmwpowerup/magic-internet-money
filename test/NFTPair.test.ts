import { ethers, network, deployments, getNamedAccounts, artifacts } from "hardhat";
import { expect } from "chai";
import { BigNumber, BigNumberish, Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";

const { keccak256, defaultAbiCoder, toUtf8Bytes, solidityPack, formatUnits, splitSignature } = ethers.utils;
const { MaxUint256, AddressZero, HashZero } = ethers.constants;
// This one was not defined..
const MaxUint128 = BigNumber.from(2).pow(128).sub(1);

import { BigRational, advanceNextTime, duration, encodeParameters, expApprox, getBigNumber, impersonate } from "../utilities";
import { BentoBoxMock, ERC20Mock, ERC721Mock, WETH9Mock, NFTPair } from "../typechain";
import { describeSnapshot } from "./helpers";
import { Cook, encodeLoanParamsNFT } from "./PrivatePool";

const LoanStatus = {
  INITIAL: 0,
  REQUESTED: 1,
  OUTSTANDING: 2,
};

interface IDeployParams {
  collateral: string;
  asset: string;
}
interface IPartialDeployParams {
  collateral?: string;
  asset?: string;
}

interface ILoanParams {
  valuation: BigNumber;
  expiration: number;
  annualInterestBPS: number;
}
interface IPartialLoanParams {
  valuation?: BigNumber;
  expiration?: number;
  annualInterestBPS?: number;
}

const DOMAIN_SEPARATOR_HASH = keccak256(toUtf8Bytes("EIP712Domain(uint256 chainId,address verifyingContract)"));

const nextYear = Math.floor(new Date().getTime() / 1000) + 86400 * 365;
const nextDecade = Math.floor(new Date().getTime() / 1000) + 86400 * 365 * 10;

describe("NFT Pair", async () => {
  let apes: ERC721Mock;
  let guineas: ERC20Mock;
  let bentoBox: BentoBoxMock;
  let masterContract: NFTPair;
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  // Named token IDs for testing..
  let apeIds: {
    aliceOne: BigNumberish;
    aliceTwo: BigNumberish;
    bobOne: BigNumberish;
    bobTwo: BigNumberish;
    carolOne: BigNumberish;
    carolTwo: BigNumberish;
  };

  const deployContract = async <T extends Contract>(name, ...args) => {
    const contract = await ethers.getContractFactory(name).then((f) => f.deploy(...args));
    // Simpler way to "cast"? The above works as the result if we igore types..
    return ethers.getContractAt<T>(name, contract.address);
  };

  const deployPair = async (options: IPartialDeployParams = {}) => {
    const { collateral = apes.address, asset = guineas.address } = options;
    const deployTx = await bentoBox
      .deploy(masterContract.address, encodeParameters(["address", "address"], [collateral, asset]), false)
      .then((tx) => tx.wait());
    for (const e of deployTx.events || []) {
      if (e.eventSignature == "LogDeploy(address,bytes,address)") {
        return ethers.getContractAt<NFTPair>("NFTPair", e.args?.cloneAddress);
      }
    }
    throw new Error("Deploy event not found"); // (For the typechecker..)
  };

  const addToken = (pool, tokenId, params: IPartialLoanParams) =>
    pool.connect(alice).updateLoanParams(tokenId, {
      valuation: 0,
      expiration: nextYear,
      openFeeBPS: 1000,
      annualInterestBPS: 2000,
      ...params,
    });

  // Specific to the mock implementation..
  const mintApe = async (ownerAddress) => {
    const id = await apes.totalSupply();
    await apes.mint(ownerAddress);
    return id;
  };

  before(async () => {
    const weth = await deployContract("WETH9Mock");
    bentoBox = await deployContract("BentoBoxMock", weth.address);
    masterContract = await deployContract("NFTPair", bentoBox.address);
    await bentoBox.whitelistMasterContract(masterContract.address, true);
    apes = await deployContract("ERC721Mock");
    guineas = await deployContract("ERC20Mock", MaxUint256);

    const addresses = await getNamedAccounts();
    deployer = await ethers.getSigner(addresses.deployer);
    alice = await ethers.getSigner(addresses.alice);
    bob = await ethers.getSigner(addresses.bob);
    carol = await ethers.getSigner(addresses.carol);

    const mc = masterContract.address;
    const hz = HashZero;
    for (const signer of [alice, bob, carol]) {
      const addr = signer.address;
      const bb = bentoBox.connect(signer);
      await bb.setMasterContractApproval(addr, mc, true, 0, hz, hz);

      await guineas.transfer(addr, getBigNumber(10_000));
      await guineas.connect(signer).approve(bentoBox.address, MaxUint256);
      await bb.deposit(guineas.address, addr, addr, getBigNumber(3000), 0);
    }
    await guineas.approve(bentoBox.address, MaxUint256);
    await bentoBox.addProfit(guineas.address, getBigNumber(11000));

    // Guineas: 9000 in, 11k profit => 9k shares is 20k guineas.
    // ---- alice:
    // Guineas:            7000.0
    // Guineas (BentoBox): 6666.666666666666666666 (3000.0 shares)

    apeIds = {
      aliceOne: await mintApe(alice.address),
      aliceTwo: await mintApe(alice.address),
      bobOne: await mintApe(bob.address),
      bobTwo: await mintApe(bob.address),
      carolOne: await mintApe(carol.address),
      carolTwo: await mintApe(carol.address),
    };
  });

  describeSnapshot("Deployment", () => {
    let pool: NFTPair;

    before(async () => {
      pool = await deployPair();
    });

    it("Should deploy with expected parameters", async () => {
      expect(await pool.asset()).to.equal(guineas.address);
      expect(await pool.collateral()).to.equal(apes.address);
    });

    it("Should reject bad settings", async () => {
      await expect(deployPair({ collateral: AddressZero })).to.be.revertedWith("NFTPair: bad pair");
    });

    it("Should refuse to initialize twice", async () => {
      await expect(pool.init(encodeParameters(["address", "address"], [apes.address, guineas.address]))).to.be.revertedWith(
        "NFTPair: already initialized"
      );
    });
  });

  describeSnapshot("Request Loan", () => {
    let tomorrow: number;
    let pair: NFTPair;

    before(async () => {
      tomorrow = Math.floor(new Date().getTime() / 1000) + 86400;

      pair = await deployPair();

      for (const signer of [deployer, alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }
    });

    it("Should let anyone with an NFT request a loan against it", async () => {
      const params = {
        valuation: getBigNumber(10),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };
      await expect(pair.connect(alice).requestLoan(apeIds.aliceOne, params, alice.address, false))
        .to.emit(apes, "Transfer")
        .withArgs(alice.address, pair.address, apeIds.aliceOne)
        .to.emit(pair, "LogRequestLoan")
        .withArgs(alice.address, apeIds.aliceOne, params.valuation, params.expiration, params.annualInterestBPS);
    });

    it("Should let anyone with an NFT request a loan (skim)", async () => {
      // The intended use case of skimming is one transaction; this is not that
      // situation. But since we are the only one interacting with the contract
      // the logic still works:
      const params = {
        valuation: getBigNumber(10),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };
      await apes.connect(alice).transferFrom(alice.address, pair.address, apeIds.aliceOne);
      await expect(pair.connect(alice).requestLoan(apeIds.aliceOne, params, alice.address, true)).to.emit(pair, "LogRequestLoan");
    });

    it("Should fail to skim if token not present", async () => {
      const params = {
        valuation: getBigNumber(10),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };
      await expect(pair.connect(alice).requestLoan(apeIds.aliceOne, params, alice.address, true)).to.be.revertedWith("NFTPair: skim failed");
    });

    it("Should refuse second request. Important if skimming!", async () => {
      const params = {
        valuation: getBigNumber(10),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };
      await expect(pair.connect(alice).requestLoan(apeIds.aliceOne, params, alice.address, false)).to.emit(pair, "LogRequestLoan");
      await expect(pair.connect(bob).requestLoan(apeIds.aliceOne, params, bob.address, true)).to.be.revertedWith("NFTPair: loan exists");
    });

    it("Should refuse loan requests without collateral", async () => {
      const params = {
        valuation: getBigNumber(10),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };
      await expect(pair.connect(alice).requestLoan(apeIds.bobOne, params, alice.address, false)).to.be.revertedWith("From not owner");
    });
  });

  describeSnapshot("Lend", async () => {
    let tomorrow: number;
    let params1: ILoanParams;
    let pair: NFTPair;

    before(async () => {
      pair = await deployPair();
      tomorrow = Math.floor(new Date().getTime() / 1000) + 86400;

      for (const signer of [alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }

      params1 = {
        valuation: getBigNumber(1000),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };

      await pair.connect(alice).requestLoan(apeIds.aliceOne, params1, alice.address, false);

      await pair.connect(bob).requestLoan(apeIds.bobOne, params1, bob.address, false);

      // One on behalf of someone else:
      await pair.connect(bob).requestLoan(apeIds.bobTwo, params1, carol.address, false);
    });

    const getShares = ({ valuation }: ILoanParams) => {
      const total = valuation.mul(9).div(20);

      // The lender:
      // - Lends out the total
      // - Receives the open fee
      // - Pays the protocol fee (part of the open fee)
      // The borrower
      // - Receives the total
      // - Pays the open fee
      // The contract
      // - Keeps the protocol fee
      const openFee = total.div(100);
      const protocolFee = openFee.div(10);

      const borrowerIn = total.sub(openFee);
      const lenderOut = total.sub(openFee).add(protocolFee);
      return { openFee, protocolFee, borrowerIn, lenderOut };
    };

    it("Should allow anyone to lend", async () => {
      const { lenderOut, borrowerIn } = getShares(params1);

      await expect(pair.connect(carol).lend(apeIds.aliceOne, params1, false))
        .to.emit(pair, "LogLend")
        .withArgs(carol.address, apeIds.aliceOne)
        .to.emit(bentoBox, "LogTransfer")
        .withArgs(guineas.address, carol.address, pair.address, lenderOut)
        .to.emit(bentoBox, "LogTransfer")
        .withArgs(guineas.address, pair.address, alice.address, borrowerIn);

      const loan = await pair.tokenLoan(apeIds.aliceOne);
      expect(loan.lender).to.equal(carol.address);
      expect(loan.borrower).to.equal(alice.address);
      expect(loan.status).to.equal(LoanStatus.OUTSTANDING);
    });

    it("Should allow anyone to lend (skim)", async () => {
      const { lenderOut } = getShares(params1);

      await bentoBox.connect(carol).transfer(guineas.address, carol.address, pair.address, lenderOut);
      await expect(pair.connect(carol).lend(apeIds.aliceOne, params1, true)).to.emit(pair, "LogLend");
    });

    it("Should revert if skim amount is too low", async () => {
      const { lenderOut } = getShares(params1);
      const oneLess = lenderOut.sub(1);

      await bentoBox.connect(carol).transfer(guineas.address, carol.address, pair.address, oneLess);
      await expect(pair.connect(carol).lend(apeIds.aliceOne, params1, true)).to.be.revertedWith("NFTPair: skim too much");
    });

    it("Should allow collateralizing a loan for someone else", async () => {
      const { lenderOut, borrowerIn } = getShares(params1);

      // Loan was requested by Bob, but money and option to repay go to Carol:
      await expect(pair.connect(alice).lend(apeIds.bobTwo, params1, false))
        .to.emit(pair, "LogLend")
        .withArgs(alice.address, apeIds.bobTwo)
        .to.emit(bentoBox, "LogTransfer")
        .withArgs(guineas.address, alice.address, pair.address, lenderOut)
        .to.emit(bentoBox, "LogTransfer")
        .withArgs(guineas.address, pair.address, carol.address, borrowerIn);

      const loan = await pair.tokenLoan(apeIds.bobTwo);
      expect(loan.lender).to.equal(alice.address);
      expect(loan.borrower).to.equal(carol.address);
    });

    it("Should lend if expiration is earlier than expected", async () => {
      const later = { ...params1, expiration: params1.expiration + 1 };
      await expect(pair.connect(carol).lend(apeIds.aliceOne, later, false)).to.emit(pair, "LogLend");
    });

    it("Should lend if interest is higher than expected", async () => {
      const less = {
        ...params1,
        annualInterestBPS: params1.annualInterestBPS - 1,
      };
      await expect(pair.connect(carol).lend(apeIds.aliceOne, less, false)).to.emit(pair, "LogLend");
    });

    it("Should NOT lend if valuation is off", async () => {
      const tooHigh = { ...params1, valuation: params1.valuation.add(1) };
      const tooLow = { ...params1, valuation: params1.valuation.sub(1) };

      await expect(pair.connect(carol).lend(apeIds.aliceOne, tooHigh, false)).to.be.revertedWith("NFTPair: bad params");
      await expect(pair.connect(carol).lend(apeIds.aliceOne, tooLow, false)).to.be.revertedWith("NFTPair: bad params");
    });

    it("Should NOT lend if expiration is later than expected", async () => {
      const earlier = { ...params1, expiration: params1.expiration - 1 };
      await expect(pair.connect(carol).lend(apeIds.aliceOne, earlier, false)).to.be.revertedWith("NFTPair: bad params");
    });

    it("Should NOT lend if interest is lower than expected", async () => {
      const more = {
        ...params1,
        annualInterestBPS: params1.annualInterestBPS + 1,
      };
      await expect(pair.connect(carol).lend(apeIds.aliceOne, more, false)).to.be.revertedWith("NFTPair: bad params");
    });

    it("Should only lend against the same token once", async () => {
      await expect(pair.connect(carol).lend(apeIds.aliceOne, params1, false)).to.emit(pair, "LogLend");
      await expect(pair.connect(carol).lend(apeIds.aliceOne, params1, false)).to.be.revertedWith("NFTPair: not available");
    });

    it("Should only lend if a request was made with collateral", async () => {
      await expect(pair.connect(carol).lend(apeIds.aliceTwo, params1, false)).to.be.revertedWith("NFTPair: not available");
    });
  });

  describeSnapshot("Update Loan Params", () => {
    let tomorrow: number;
    let params1: ILoanParams;
    let pair: NFTPair;

    before(async () => {
      pair = await deployPair();
      tomorrow = Math.floor(new Date().getTime() / 1000) + 86400;

      for (const signer of [alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }

      params1 = {
        valuation: getBigNumber(1000),
        expiration: tomorrow,
        annualInterestBPS: 2000,
      };

      await pair.connect(alice).requestLoan(apeIds.aliceOne, params1, alice.address, false);
    });

    it("Should allow borrowers any update to loan requests", async () => {
      const data: ILoanParams[] = [params1];
      const recordUpdate = (k, f) => {
        const params = data[data.length - 1];
        data.push({ ...params, [k]: f(params[k]) });
      };
      recordUpdate("valuation", (v) => v.add(10));
      recordUpdate("valuation", (v) => v.sub(20_000_000));
      recordUpdate("annualInterestBPS", (i) => i - 400);
      recordUpdate("annualInterestBPS", (i) => i + 300);
      recordUpdate("expiration", (e) => e + 10_000);
      recordUpdate("expiration", (e) => e - 98_765);

      for (const params of data) {
        await expect(pair.connect(alice).updateLoanParams(apeIds.aliceOne, params))
          .to.emit(pair, "LogUpdateLoanParams")
          .withArgs(apeIds.aliceOne, params.valuation, params.expiration, params.annualInterestBPS);
      }
    });

    it("Should refuse updates to someone else's requests", async () => {
      const params2 = { ...params1, expiration: params1.expiration + 2 };
      await expect(pair.connect(bob).updateLoanParams(apeIds.aliceOne, params2)).to.be.revertedWith("NFTPair: not the borrower");
    });

    it("..even if you set the loan up for them", async () => {
      const params2 = { ...params1, expiration: params1.expiration + 2 };
      await pair.connect(bob).requestLoan(apeIds.bobOne, params1, alice.address, false);
      await expect(pair.connect(bob).updateLoanParams(apeIds.bobOne, params2)).to.be.revertedWith("NFTPair: not the borrower");
    });

    it("Should refuse updates to nonexisting loans", async () => {
      const params2 = { ...params1, expiration: params1.expiration + 2 };
      await expect(pair.connect(alice).updateLoanParams(apeIds.aliceTwo, params2)).to.be.revertedWith("NFTPair: no collateral");
    });

    it("Should refuse non-lender updates to outstanding loans", async () => {
      const params2 = { ...params1, expiration: params1.expiration - 2 };
      await expect(pair.connect(alice).updateLoanParams(apeIds.aliceOne, params2)).to.emit(pair, "LogUpdateLoanParams");

      await pair.connect(carol).lend(apeIds.aliceOne, params2, false);

      // Borrower:
      await expect(pair.connect(alice).updateLoanParams(apeIds.aliceOne, params1)).to.be.revertedWith("NFTPair: not the lender");

      // Someone else:
      await expect(pair.connect(bob).updateLoanParams(apeIds.aliceOne, params1)).to.be.revertedWith("NFTPair: not the lender");
    });

    it("Should accept same or better conditions from lender", async () => {
      const data = [params1];
      const recordUpdate = (k, f) => {
        const params = data[data.length - 1];
        data.push({ ...params, [k]: f(params[k]) });
      };
      recordUpdate("valuation", (v) => v.sub(10));
      recordUpdate("annualInterestBPS", (i) => i - 400);
      recordUpdate("expiration", (e) => e + 10_000);

      await pair.connect(carol).lend(apeIds.aliceOne, params1, false);

      for (const params of data) {
        await expect(pair.connect(carol).updateLoanParams(apeIds.aliceOne, params)).to.emit(pair, "LogUpdateLoanParams");
      }
    });

    it("Should refuse worse conditions from lender", async () => {
      const data: ILoanParams[] = [];
      const recordUpdate = (k, f) => {
        data.push({ ...params1, [k]: f(params1[k]) });
      };
      recordUpdate("valuation", (v) => v.add(1));
      recordUpdate("annualInterestBPS", (i) => i + 1);
      recordUpdate("expiration", (e) => e - 1);

      await pair.connect(carol).lend(apeIds.aliceOne, params1, false);

      for (const params of data) {
        await expect(pair.connect(carol).updateLoanParams(apeIds.aliceOne, params)).to.be.revertedWith("NFTPair: worse params");
      }
    });
  });

  describeSnapshot("Remove Collateral", () => {
    let pair: NFTPair;
    const params: ILoanParams = {
      valuation: getBigNumber(123),
      annualInterestBPS: 10_000,
      expiration: Math.floor(new Date().getTime() / 1000) + 86400,
    };

    before(async () => {
      pair = await deployPair();

      for (const signer of [deployer, alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }

      for (const id of [apeIds.aliceOne, apeIds.aliceTwo]) {
        await pair.connect(alice).requestLoan(id, params, alice.address, false);
      }
      await pair.connect(bob).lend(apeIds.aliceOne, params, false);
    });

    it("Should allow borrowers to remove unused collateral", async () => {
      await expect(pair.connect(alice).removeCollateral(apeIds.aliceTwo, alice.address))
        .to.emit(pair, "LogRemoveCollateral")
        .withArgs(apeIds.aliceTwo, alice.address)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, alice.address, apeIds.aliceTwo);
    });

    it("Should not allow others to remove unused collateral", async () => {
      await expect(pair.connect(bob).removeCollateral(apeIds.aliceTwo, alice.address)).to.be.revertedWith("NFTPair: not the borrower");
    });

    it("Should not allow borrowers to remove used collateral", async () => {
      await expect(pair.connect(alice).removeCollateral(apeIds.aliceOne, alice.address)).to.be.revertedWith("NFTPair: not the lender");
    });

    it("Should allow lenders to seize collateral upon expiry", async () => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration]);
      // Send it to someone else for a change:
      await expect(pair.connect(bob).removeCollateral(apeIds.aliceOne, carol.address))
        .to.emit(pair, "LogRemoveCollateral")
        .withArgs(apeIds.aliceOne, carol.address)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, carol.address, apeIds.aliceOne);
    });

    it("Should not allow lenders to seize collateral otherwise", async () => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration - 1]);
      await expect(pair.connect(bob).removeCollateral(apeIds.aliceOne, carol.address)).to.be.revertedWith("NFTPair: not expired");
    });

    it("Should not allow others to seize collateral ever", async () => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration - 1]);
      await expect(pair.connect(carol).removeCollateral(apeIds.aliceOne, carol.address)).to.be.revertedWith("NFTPair: not the lender");

      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration + 1_000_000]);
      await expect(pair.connect(carol).removeCollateral(apeIds.aliceOne, carol.address)).to.be.revertedWith("NFTPair: not the lender");
    });
  });

  describeSnapshot("Repay", () => {
    let pair: NFTPair;

    const DAY = 24 * 3600;
    const YEAR = 365 * DAY;
    const params: ILoanParams = {
      valuation: getBigNumber(1),
      annualInterestBPS: 10_000,
      expiration: Math.floor(new Date().getTime() / 1000) + YEAR,
    };
    const valuationShare = params.valuation.mul(9).div(20);
    const borrowerShare = valuationShare.mul(99).div(100);

    // Theoretically this could fail to actually bound the repay share because
    // of the FP math used. Double check using a more exact method if that
    // happens:
    const YEAR_BPS = YEAR * 10_000;
    const COMPOUND_TERMS = 6;
    const getMaxRepayShare = (time, params_) => {
      // We mimic what the contract does, but without rounding errors in the
      // approximation, so the upper bound should be strict.
      // 1. Calculate exact amount owed; round it down, like the contract does.
      // 2. Convert that to Bento shares (still hardcoded at 9/20); rounding up
      const x = BigRational.from(time * params_.annualInterestBPS).div(YEAR_BPS);
      return expApprox(x, COMPOUND_TERMS).mul(params_.valuation).floor().mul(9).add(19).div(20);
    };

    before(async () => {
      pair = await deployPair();

      for (const signer of [deployer, alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }

      for (const id of [apeIds.aliceOne, apeIds.aliceTwo]) {
        await pair.connect(alice).requestLoan(id, params, alice.address, false);
      }
      await pair.connect(bob).lend(apeIds.aliceOne, params, false);
    });

    it("Should allow borrowers to pay off loans before expiry", async () => {
      const getBalances = async () => ({
        alice: await bentoBox.balanceOf(guineas.address, alice.address),
        bob: await bentoBox.balanceOf(guineas.address, bob.address),
        pair: await bentoBox.balanceOf(guineas.address, pair.address),
        feeTracker: await pair.feesEarnedShare(),
      });
      const t0 = await getBalances();

      // Two Bento transfers: payment to the lender, fee to the contract
      await advanceNextTime(DAY);
      await expect(pair.connect(alice).repay(apeIds.aliceOne, false))
        .to.emit(pair, "LogRepay")
        .withArgs(alice.address, apeIds.aliceOne)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, alice.address, apeIds.aliceOne)
        .to.emit(bentoBox, "LogTransfer")
        .to.emit(bentoBox, "LogTransfer");

      const t1 = await getBalances();
      const maxRepayShare = getMaxRepayShare(DAY, params);
      const linearInterest = valuationShare.mul(params.annualInterestBPS).mul(DAY).div(YEAR_BPS);

      const paid = t0.alice.sub(t1.alice);
      expect(paid).to.be.gte(valuationShare.add(linearInterest));
      expect(paid).to.be.lte(maxRepayShare);

      // The difference is rounding errors only, so should be very small:
      const paidError = maxRepayShare.sub(paid);
      expect(paidError.mul(1_000_000_000)).to.be.lt(paid);

      // The fee is hardcoded at 10% of the interest
      const fee = t1.feeTracker.sub(t0.feeTracker);
      expect(fee.mul(10)).to.be.gte(linearInterest);
      expect(fee.mul(10)).to.be.lte(paid.sub(valuationShare));
      expect(t1.pair.sub(t0.pair)).to.equal(fee);

      const received = t1.bob.sub(t0.bob);
      expect(received.add(fee)).to.equal(paid);
    });

    it("Should allow paying off loans for someone else", async () => {
      // ..and take from the correct person:
      const getBalances = async () => ({
        alice: await bentoBox.balanceOf(guineas.address, alice.address),
        bob: await bentoBox.balanceOf(guineas.address, bob.address),
        carol: await bentoBox.balanceOf(guineas.address, carol.address),
        pair: await bentoBox.balanceOf(guineas.address, pair.address),
        feeTracker: await pair.feesEarnedShare(),
      });
      const t0 = await getBalances();

      await advanceNextTime(DAY);
      await expect(pair.connect(carol).repay(apeIds.aliceOne, false))
        .to.emit(pair, "LogRepay")
        .withArgs(carol.address, apeIds.aliceOne)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, alice.address, apeIds.aliceOne)
        .to.emit(bentoBox, "LogTransfer")
        .to.emit(bentoBox, "LogTransfer");

      const t1 = await getBalances();
      const maxRepayShare = getMaxRepayShare(DAY, params);

      // Alice paid or received nothing:
      expect(t0.alice).to.equal(t1.alice);

      const paid = t0.carol.sub(t1.carol);

      // The difference is rounding errors only, so should be very small:
      const paidError = maxRepayShare.sub(paid);
      expect(paidError.mul(1_000_000_000)).to.be.lt(paid);

      const fee = t1.feeTracker.sub(t0.feeTracker);
      expect(fee.mul(10)).to.be.lte(paid.sub(valuationShare));
      expect(t1.pair.sub(t0.pair)).to.equal(fee);

      const received = t1.bob.sub(t0.bob);
      expect(received.add(fee)).to.equal(paid);
    });

    it("Should allow paying off loans for someone else (skim)", async () => {
      const interval = 234 * DAY + 5678;
      // Does not matter who supplies the payment. Note that there will be
      // an excess left; skimming is really only suitable for contracts that
      // can calculate the exact repayment needed:
      const exactAmount = params.valuation.add(await pair.calculateInterest(params.valuation, interval, params.annualInterestBPS));
      // The contract rounds down; we round up and add a little:
      const closeToShare = exactAmount.mul(9).add(19).div(20);
      const enoughShare = closeToShare.add(getBigNumber(1337, 8));

      // This would normally be done in the same transaction...
      await bentoBox.connect(bob).transfer(guineas.address, bob.address, pair.address, enoughShare);

      const getBalances = async () => ({
        alice: await bentoBox.balanceOf(guineas.address, alice.address),
        bob: await bentoBox.balanceOf(guineas.address, bob.address),
        carol: await bentoBox.balanceOf(guineas.address, carol.address),
        pair: await bentoBox.balanceOf(guineas.address, pair.address),
        feeTracker: await pair.feesEarnedShare(),
      });
      const t0 = await getBalances();

      await ethers.provider.send("evm_setNextBlockTimestamp", [(await pair.tokenLoan(apeIds.aliceOne)).startTime.toNumber() + interval]);
      await expect(pair.connect(carol).repay(apeIds.aliceOne, true))
        .to.emit(pair, "LogRepay")
        .withArgs(pair.address, apeIds.aliceOne)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, alice.address, apeIds.aliceOne)
        .to.emit(bentoBox, "LogTransfer")
        .to.emit(bentoBox, "LogTransfer");

      const t1 = await getBalances();
      const maxRepayShare = getMaxRepayShare(interval, params);

      // Alice paid or received nothing:
      expect(t0.alice).to.equal(t1.alice);

      // Neither did Carol, who skimmed the preexisting excess balance:
      expect(t0.carol).to.equal(t1.carol);

      // The pair kept the fee and the excess, but sent the repayment to Bob:
      const fee = t1.feeTracker.sub(t0.feeTracker);
      expect(t1.pair).to.be.gte(t1.feeTracker);

      // The skimmable amount covers the entire payment:
      const received = t1.bob.sub(t0.bob);

      const paid = received.add(fee);
      expect(paid).to.be.lte(enoughShare);

      // Funds either went to Bob or stayed with the pair:
      expect(t0.pair.sub(t1.pair)).to.equal(received);

      const leftover = t1.pair.sub(t1.feeTracker);
      expect(leftover).to.equal(enoughShare.sub(paid));

      expect(fee.mul(10)).to.be.lte(paid.sub(valuationShare));
    });

    it("Should work for a large, but repayable, number", async () => {
      const fiveYears = 5 * YEAR;
      const large: ILoanParams = {
        valuation: getBigNumber(1_000_000_000),
        annualInterestBPS: 65_535,
        expiration: Math.floor(new Date().getTime() / 1000) + 2 * fiveYears,
      };

      await pair.connect(alice).updateLoanParams(apeIds.aliceTwo, large);

      await guineas.transfer(bob.address, large.valuation);
      await guineas.transfer(alice.address, MaxUint128);

      // Alice and Bob already had something deposited; this will ensure they
      // can pay. Alice's total must not overflow the max BB balance..
      await bentoBox.connect(bob).deposit(guineas.address, bob.address, bob.address, large.valuation, 0);
      // (Don't overflow the BentoBox..)
      await bentoBox.connect(alice).deposit(guineas.address, alice.address, alice.address, MaxUint128.div(2), 0);

      await pair.connect(bob).lend(apeIds.aliceTwo, large, false);

      const getBalances = async () => ({
        alice: await bentoBox.balanceOf(guineas.address, alice.address),
        bob: await bentoBox.balanceOf(guineas.address, bob.address),
        pair: await bentoBox.balanceOf(guineas.address, pair.address),
        feeTracker: await pair.feesEarnedShare(),
      });
      const t0 = await getBalances();

      const inFive = await advanceNextTime(fiveYears);

      await expect(pair.connect(alice).repay(apeIds.aliceTwo, false))
        .to.emit(pair, "LogRepay")
        .withArgs(alice.address, apeIds.aliceTwo)
        .to.emit(apes, "Transfer")
        .withArgs(pair.address, alice.address, apeIds.aliceTwo)
        .to.emit(bentoBox, "LogTransfer")
        .to.emit(bentoBox, "LogTransfer");

      const t1 = await getBalances();
      const maxRepayShare = getMaxRepayShare(fiveYears, large);
      const linearInterest = valuationShare.mul(large.annualInterestBPS).mul(fiveYears).div(YEAR_BPS);

      const paid = t0.alice.sub(t1.alice);
      expect(paid).to.be.gte(valuationShare.add(linearInterest));
      expect(paid).to.be.lte(maxRepayShare);

      // The interest really is ridiculous:
      expect(paid).to.be.gte(valuationShare.mul(170_000_000_000_000n));

      // The difference is rounding errors only, so should be very small:
      const difference = maxRepayShare.sub(paid);
      expect(difference.mul(1_000_000_000)).to.be.lt(paid);

      // The difference is rounding errors only, so should be very small:
      const paidError = maxRepayShare.sub(paid);
      expect(paidError.mul(1_000_000_000)).to.be.lt(paid);

      // Lower bound makes little sense here..
      const fee = t1.feeTracker.sub(t0.feeTracker);
      expect(fee.mul(10)).to.be.lte(paid.sub(valuationShare));
      expect(t1.pair.sub(t0.pair)).to.equal(fee);

      const received = t1.bob.sub(t0.bob);
      expect(received.add(fee)).to.equal(paid);
    });

    it("Should refuse repayments on expired loans", async () => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration]);
      await expect(pair.connect(alice).repay(apeIds.aliceOne, false)).to.be.revertedWith("NFTPair: loan expired");
    });

    it("Should refuse repayments on nonexistent loans", async () => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [params.expiration]);
      await expect(pair.connect(carol).repay(apeIds.carolOne, false)).to.be.revertedWith("NFTPair: no loan");
    });

    it("Should refuse to skim too much", async () => {
      const interval = 234 * DAY + 5678;
      // Does not matter who supplies the payment. Note that there will be
      // an excess left; skimming is really only suitable for contracts that
      // can calculate the exact repayment needed:
      const exactAmount = params.valuation.add(await pair.calculateInterest(params.valuation, interval, params.annualInterestBPS));
      // Round down and subtract some more to be sure, but close:
      const notEnoughShare = exactAmount.mul(9).div(20).sub(1337);

      await bentoBox.connect(bob).transfer(guineas.address, bob.address, pair.address, notEnoughShare);

      await ethers.provider.send("evm_setNextBlockTimestamp", [(await pair.tokenLoan(apeIds.aliceOne)).startTime.toNumber() + interval]);
      await expect(pair.connect(carol).repay(apeIds.aliceOne, true)).to.be.revertedWith("NFTPair: skim too much");
    });
  });

  describeSnapshot("Signed Lend/Borrow", async () => {
    let pair: NFTPair;
    let chainId: BigNumberish;
    let DOMAIN_SEPARATOR: string;
    let BORROW_SIGNATURE_HASH: string;
    let LEND_SIGNATURE_HASH: string;

    before(async () => {
      pair = await deployPair();

      chainId = (await ethers.provider.getNetwork()).chainId;

      // TODO: Verify that after a fork this becomes part of the clone
      // TODO: Does that matter though? Just use whatever it is?
      // TODO: Yes! Need correct asset/coll addresses in the sig also!
      DOMAIN_SEPARATOR = keccak256(
        defaultAbiCoder.encode(["bytes32", "uint256", "address"], [DOMAIN_SEPARATOR_HASH, chainId, masterContract.address])
      );

      for (const signer of [deployer, alice, bob, carol]) {
        await apes.connect(signer).setApprovalForAll(pair.address, true);
      }

      // TODO: Check whether this interferes?
      // for (const id of [apeIds.aliceOne, apeIds.aliceTwo]) {
      //   await pair.connect(alice).requestLoan(id, params, alice.address, false);
      // }
      // await pair.connect(bob).lend(apeIds.aliceOne, params, false);
    });

    // Ops happen to have the same method signature other than their name:
    const signRequest = async (wallet, op: "Lend" | "Borrow", { tokenId, valuation, expiration, annualInterestBPS, deadline }) => {
      const sigTypes = [
        { name: "contract", type: "address" },
        { name: "collateral", type: "address" },
        { name: "asset", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "valuation", type: "uint128" },
        { name: "expiration", type: "uint64" },
        { name: "annualInterestBPS", type: "uint16" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ];
      // const sigArgs = sigTypes.map((t) => t.type + " " + t.name);
      // const sigHash = keccak256(
      //   toUtf8Bytes(op + "(" + sigArgs.join(",") + ")")
      // );

      const sigValues = {
        contract: pair.address,
        collateral: apes.address,
        asset: guineas.address,
        tokenId,
        valuation,
        expiration,
        annualInterestBPS,
        nonce: 0,
        deadline,
      };
      // const dataHash = keccak256(defaultAbiCoder.encode(
      //   ["bytes32 sigHash", ...sigArgs],
      //   Object.values({ sigHash, ...sigValues })
      // ));
      // const digest = keccak256(
      //   solidityPack(
      //     ["string", "bytes32", "bytes32"],
      //     ["\x19\x01", DOMAIN_SEPARATOR, dataHash]
      //   )
      // );

      // At this point we'd like to sign this digest, but signing arbitrary
      // data is made difficult in ethers.js to prevent abuse. So for now we
      // use a helper method that basically does everything we just did again:
      const sig = await wallet._signTypedData(
        // The stuff going into DOMAIN_SEPARATOR:
        { chainId, verifyingContract: masterContract.address },

        // sigHash
        { [op]: sigTypes },
        sigValues
      );
      return splitSignature(sig);
    };

    it("Should have the expected DOMAIN_SEPARATOR", async () => {
      expect(DOMAIN_SEPARATOR).to.equal(await pair.DOMAIN_SEPARATOR());
    });

    describe("Lend", () => {
      // The borrower somehow obtains the signature, then requests and gets the
      // loan in one step:
      it("Should support pre-approving a loan request", async () => {
        // Bob agrees to lend 100 guineas agaist token "carolOne", to be repaid
        // no later one year from now. This offer is good for one hour, and can
        // be taken up by anyone who can provide the token (and the signature).
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Lend", {
          tokenId: apeIds.carolOne,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        // Carol takes the loan:
        await expect(
          pair
            .connect(carol)
            .requestAndBorrow(
              apeIds.carolOne,
              bob.address,
              carol.address,
              { valuation, expiration, annualInterestBPS },
              false,
              deadline,
              v,
              r,
              s
            )
        )
          .to.emit(pair, "LogRequestLoan")
          .to.emit(pair, "LogLend");
      });

      it("Should require an exact match on all conditions", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Lend", {
          tokenId: apeIds.carolOne,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        // Carol tries to take the loan, but fails because oneo of the
        // parameters is different. This pretty much only tests that we do the
        // signature check at all, and it feels a bit silly to check every
        // variable: if the "success" case passes and any one of these fails,
        // then the hash is being checked.
        // (Similarly, we could check the token ID, contract, token contracts,
        // etc, but we don't, because we know we are hashing those.)
        for (const [key, value] of Object.entries(loanParams)) {
          const altered = BigNumber.from(value).add(1);
          const badLoanParams = { ...loanParams, [key]: altered };
          await expect(
            pair.connect(carol).requestAndBorrow(apeIds.carolOne, bob.address, carol.address, badLoanParams, false, deadline, v, r, s)
          ).to.be.revertedWith("NFTPair: signature invalid");
        }
      });

      it("Should require the lender to be the signer", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Lend", {
          tokenId: apeIds.carolOne,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        // Carol tries to take the loan from Alice instead and fails:
        await expect(
          pair.connect(carol).requestAndBorrow(apeIds.carolOne, alice.address, carol.address, loanParams, false, deadline, v, r, s)
        ).to.be.revertedWith("NFTPair: signature invalid");
      });

      it("Should enforce the deadline", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Lend", {
          tokenId: apeIds.carolOne,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        const successParams = [apeIds.carolOne, bob.address, carol.address, loanParams, false, deadline, v, r, s] as const;

        // Request fails because the deadline has expired:
        await advanceNextTime(3601);
        await expect(pair.connect(carol).requestAndBorrow(...successParams)).to.be.revertedWith("NFTPair: signature expired");
      });

      it("Should not accept the same signature twice", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Lend", {
          tokenId: apeIds.carolOne,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        const successParams = [apeIds.carolOne, bob.address, carol.address, loanParams, false, deadline, v, r, s] as const;

        // It works the first time:
        await expect(pair.connect(carol).requestAndBorrow(...successParams)).to.emit(pair, "LogLend");

        // Carol repays the loan to get the token back:
        await expect(pair.connect(carol).repay(apeIds.carolOne, false)).to.emit(pair, "LogRepay");
        expect(await apes.ownerOf(apeIds.carolOne)).to.equal(carol.address);

        // It fails now (because the nonce is no longer a match):
        await expect(pair.connect(carol).requestAndBorrow(...successParams)).to.be.revertedWith("NFTPair: signature invalid");
      });
    });

    describe("Borrow", () => {
      // Signing a commitment to borrow mainly differs in that:
      // - It is not put on chain  until the loan is actually made
      // - Only the recipient (of the signed message, for now) can lend
      // - The borrower can pull out by failing to satisfy the conditions for
      //   `requestLoan`.
      it("Should let borrowers sign a private loan request", async () => {
        // Bob commits to borrow 100 guineas and supply token "bobTwo" as
        // collateral, to be repaid no later than a year from now. The offer is
        // good for one hour, and anyone willing to lend at these terms can
        // take it up - if they have the signature.
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Borrow", {
          tokenId: apeIds.bobTwo,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        // Alice takes the loan:
        await expect(
          pair
            .connect(alice)
            .takeCollateralAndLend(apeIds.bobTwo, bob.address, { valuation, expiration, annualInterestBPS }, false, deadline, v, r, s)
        )
          .to.emit(pair, "LogRequestLoan")
          .to.emit(pair, "LogLend");
      });

      it("Should require an exact match on all conditions", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Borrow", {
          tokenId: apeIds.bobTwo,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        for (const [key, value] of Object.entries(loanParams)) {
          const altered = BigNumber.from(value).add(1);
          const badLoanParams = { ...loanParams, [key]: altered };
          await expect(
            pair.connect(alice).takeCollateralAndLend(apeIds.bobTwo, bob.address, badLoanParams, false, deadline, v, r, s)
          ).to.be.revertedWith("NFTPair: signature invalid");
        }
      });

      it("Should require the borrower to be the signer", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Borrow", {
          tokenId: apeIds.bobTwo,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };
        // Alice tries to lend to Carol instead and fails:
        await expect(
          pair.connect(alice).takeCollateralAndLend(apeIds.bobTwo, carol.address, loanParams, false, deadline, v, r, s)
        ).to.be.revertedWith("NFTPair: signature invalid");
      });

      it("Should enforce the deadline", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Borrow", {
          tokenId: apeIds.bobTwo,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };

        await advanceNextTime(3601);
        await expect(
          pair.connect(alice).takeCollateralAndLend(apeIds.bobTwo, bob.address, loanParams, false, deadline, v, r, s)
        ).to.be.revertedWith("NFTPair: signature expired");
      });

      it("Should not accept the same signature twice", async () => {
        const { timestamp } = await ethers.provider.getBlock("latest");
        const valuation = getBigNumber(100);
        const expiration = timestamp + 365 * 24 * 3600;
        const annualInterestBPS = 15000;
        const deadline = timestamp + 3600;

        const { r, s, v } = await signRequest(bob, "Borrow", {
          tokenId: apeIds.bobTwo,
          valuation,
          expiration,
          annualInterestBPS,
          deadline,
        });

        const loanParams = { valuation, expiration, annualInterestBPS };

        await expect(pair.connect(alice).takeCollateralAndLend(apeIds.bobTwo, bob.address, loanParams, false, deadline, v, r, s)).to.emit(
          pair,
          "LogLend"
        );

        // Bob repays the loan to get the token back:
        await expect(pair.connect(bob).repay(apeIds.bobTwo, false)).to.emit(pair, "LogRepay");
        expect(await apes.ownerOf(apeIds.bobTwo)).to.equal(bob.address);

        // It fails now (because the nonce is no longer a match):
        await expect(
          pair.connect(alice).takeCollateralAndLend(apeIds.bobTwo, bob.address, loanParams, false, deadline, v, r, s)
        ).to.be.revertedWith("NFTPair: signature invalid");
      });
    });

    // Not tested, in either case: the loan is set up correctly, both
    // collateral and assets change hands, etc. This happens to hold currently,
    // but that is only because the implementation is exactly "call
    // requestLoan() on behalf of the borrower, then lend() on behalf of the
    // lender".
  });
});
