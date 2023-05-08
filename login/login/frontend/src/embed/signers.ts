import {
  TEthereumAddress,
  TSignature,
} from "../services/loginProvider";
import { getProvider } from "./utils";

const verify = (recoveredAddress: string, address: string) => {
  recoveredAddress = recoveredAddress.toLowerCase();

  if (
    recoveredAddress !== address.toLowerCase()
  ) {
    throw Error(`Invalid Signature! CB Recovered address: ${recoveredAddress}`);
  }
  return true;
}

const defaultSigner = () => ({
  sign: async (message: string): Promise<string> => {
    let signer = getProvider().getSigner();
    let signature = await signer.signMessage(message);
    return signature;
  },
  verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
    const verifyMessage = (await import(/* webpackPrefetch: true */ 'ethers')).default.verifyMessage;
    let recoveredAddress = verifyMessage(message, signature);

    return verify(recoveredAddress, address);
  }
})


const personalSigner = () => {
  return {
    sign: async (message: string): Promise<string> => {
      const toUtf8Bytes = (await import(/* webpackPrefetch: true */ 'ethers')).default.toUtf8Bytes;
      const hexlify = (await import(/* webpackPrefetch: true */ 'ethers')).default.hexlify;
      const data = toUtf8Bytes(message);
      const msg = hexlify(data);

      const provider = getProvider();
      const signer = provider.getSigner();
      const addr = await signer.getAddress();

      const lowerAddress = addr.toLowerCase();
      const method = "personal_sign";
      const args = [msg, lowerAddress];

      const sig: string = await provider.send(method, args);

      return sig;
    },
    verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
      const verifyMessage = (await import(/* webpackPrefetch: true */ 'ethers')).default.verifyMessage;
      let recoveredAddress = verifyMessage(message, signature);

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

const directSigner = () => {
  return {
    sign: async (message: string): Promise<string> => {
      const toUtf8Bytes = (await import(/* webpackPrefetch: true */ 'ethers')).default.toUtf8Bytes;
      const hexlify = (await import(/* webpackPrefetch: true */ 'ethers')).default.hexlify;

      const data = toUtf8Bytes(message);
      const msg = hexlify(data);

      const provider = getProvider();
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
      const verifyMessage = (await import(/* webpackPrefetch: true */ 'ethers')).default.verifyMessage;
      let recoveredAddress = verifyMessage(message, signature);

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
  [key: string]: () => {
    sign: (message: string) => Promise<string>,
    verify: (signature: TSignature, message: string, address: TEthereumAddress) => Promise<boolean>
  }
} = ({
  default: defaultSigner,
  coinbase: personalSigner,
  opera: directSigner,
  web3: directSigner,
});
