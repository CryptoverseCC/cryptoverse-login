import {
  TEthereumAddress,
  TSignature,
} from "../services/loginProvider";
import { getProvider, getEthers } from "./utils";

const verify = (recoveredAddress: string, address: string) => {
  recoveredAddress = recoveredAddress.toLowerCase();

  if (
    recoveredAddress !== address.toLowerCase()
  ) {
    throw Error(`Invalid Signature! CB Recovered address: ${recoveredAddress}`);
  }
  return true;
}

const defaultSigner = (provider: any, ethers: any) => ({
  sign: async (message: string): Promise<string> => {
    let signer = provider.getSigner();
    let signature = await signer.signMessage(message);
    return signature;
  },
  verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
    let recoveredAddress = ethers.utils.verifyMessage(message, signature);

    return verify(recoveredAddress, address);
  }
})


const personalSigner = (provider: any, ethers: any) => {
  return {
    sign: async (message: string): Promise<string> => {
      const ethers = getEthers();

      const data = ethers.utils.toUtf8Bytes(message);
      const msg = ethers.utils.hexlify(data);

      const signer = provider.getSigner();
      const addr = await signer.getAddress();

      const lowerAddress = addr.toLowerCase();
      const method = "personal_sign";
      const args = [msg, lowerAddress];

      const sig: string = await provider.send(method, args);

      return sig;
    },
    verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
      // Now you have the digest,
      // const recoveredPubKey = ethers.utils.recoverPublicKey(msgHashBytes, signature);
      let recoveredAddress = ethers.utils.verifyMessage(message, signature);

      recoveredAddress = recoveredAddress.toLowerCase();

      if (
        recoveredAddress !== address.toLowerCase()
      ) {
        throw Error(`Invalid Signature! CB Recovered address: ${recoveredAddress}`);
      }
      return true;
    }
  };
}

const directSigner = (provider: any, ethers: any) => {
  return {
    sign: async (message: string): Promise<string> => {
      const ethers = getEthers();

      const data = ethers.utils.toUtf8Bytes(message);
      const msg = ethers.utils.hexlify(data);

      const signer = provider.getSigner();
      const addr = await signer.getAddress();

      const lowerAddress = addr.toLowerCase();
      const method = "personal_sign";
      const args = [msg, lowerAddress];

      const sig: string = await new Promise((resolve, reject) => {
        provider.provider.send({ method, params: args, id: 123, jsonrpc: "2.0" }, (error: any, result: any) => {
          if (error) {

            const err: any = new Error(error.message);
            err.code = error.code;
            err.data = error.data;
            reject(err);
          }

          resolve(result.result);
        })
      });

      return sig;
    },
    verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
      // Now you have the digest,
      // const recoveredPubKey = ethers.utils.recoverPublicKey(msgHashBytes, signature);
      let recoveredAddress = ethers.utils.verifyMessage(message, signature);

      recoveredAddress = recoveredAddress.toLowerCase();

      if (
        recoveredAddress !== address.toLowerCase()
      ) {
        throw Error(`Invalid Signature! CB Recovered address: ${recoveredAddress}`);
      }
      return true;
    }
  };
}


export const signers: {
  [key: string]: (provider: any, ethers: any) => {
    sign: (message: string) => Promise<string>,
    verify: (signature: TSignature, message: string, address: TEthereumAddress) => Promise<boolean>
  }
} = ({
  default: defaultSigner,
  coinbase: personalSigner,
  opera: directSigner,
  web3: directSigner,
});
