import { JsonRpcApiProvider } from "ethers";
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
        const verifyMessage = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-verify" */ 'ethers')).verifyMessage;
        let recoveredAddress = verifyMessage(message, signature);

        return verify(recoveredAddress, address);
    }
})


const personalSigner = () => {
    return {
        sign: async (message: string, address: string): Promise<string> => {
            const toUtf8Bytes = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-toutf" */ 'ethers')).toUtf8Bytes;
            const hexlify = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-hex" */ 'ethers')).hexlify;
            const data = toUtf8Bytes(message);
            const msg = hexlify(data);

            const provider = getProvider();
            // TODO: fix the same as directSigner
            const signer = provider.getSigner();
            const addr = await signer.getAddress();

            const lowerAddress = addr.toLowerCase();
            const method = "personal_sign";
            const args = [msg, lowerAddress];

            const sig: string = await provider.send(method, args);

            return sig;
        },
        verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
            const verifyMessage = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-verify" */ 'ethers')).verifyMessage;
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
        sign: async (message: string, address: string): Promise<string> => {
            const toUtf8Bytes = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-toutf" */ 'ethers')).toUtf8Bytes;
            const hexlify = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-hex" */ 'ethers')).hexlify;
            const JsonRpcSigner = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-json" */ 'ethers')).JsonRpcSigner;

            const data = toUtf8Bytes(message);
            const msg = hexlify(data);

            const provider: JsonRpcApiProvider = getProvider();
            const signer = new JsonRpcSigner(provider, address);
            const addr = await signer.getAddress();

            const lowerAddress = addr.toLowerCase();
            const method = "personal_sign";
            const args = [msg, lowerAddress];

            const sig: string = await provider.provider.send(method, args)

            return sig;
        },
        verify: async (signature: TSignature, message: string, address: TEthereumAddress): Promise<boolean> => {
            const verifyMessage = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "ethers-verify" */ 'ethers')).verifyMessage;
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
        sign: (message: string, address: string) => Promise<string>,
        verify: (signature: TSignature, message: string, address: TEthereumAddress) => Promise<boolean>
    }
} = ({
    default: defaultSigner,
    coinbase: personalSigner,
    opera: directSigner,
    web3: directSigner,
    metamask: directSigner,
});
