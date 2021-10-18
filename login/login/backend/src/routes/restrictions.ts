/*

restrictions:
  - tokenAddress: "0x123...456"
    condition: "balanceOf > 0"
    message: "Hello world!"
  - contractAliases:
      ALA: "0x123...456"
      MA: "0x234...567"
    condition: "ALA.balanceOf + MA.balanceOf > 0"
    message: "Hello world!"

*/

import { OAuth2Client } from "@ory/hydra-client";
import { parser as mathParser } from "mathjs";
import { ethers } from "ethers";
import { readFile } from "fs";

interface Metadata {
  app: string
  restrictions?: { token: string, condition: string }[]
}

type TAddress = string;

type TContractAlias = string;
type TContractAddress = string;
type TCondition = string;

type TContractAliases = {
  [key: string]: TContractAddress;
}

export type TRestriction = {
  contractAliases?: TContractAliases
  tokenAddress?: TContractAddress
  condition: TCondition
}

export type TRestrictions = TRestriction[]

export type TCheckResult = {
  result: Boolean,
  restriction: TRestriction,
  data: {
    [key: string]: any
  }
}

export type TCheckResults = TCheckResult[];

const TokenABI = [
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [
      {
        "name": "",
        "type": "uint8"
      }
    ],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [
      {
        "name": "_owner",
        "type": "address"
      }
    ],
    "name": "balanceOf",
    "outputs": [
      {
        "name": "balance",
        "type": "uint256"
      }
    ],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
];

const provider = ethers.getDefaultProvider("mainnet", {
  infura: process.env.INFURA_API_KEY,
  alchemy: process.env.ALCHEMY_API_KEY,
});


export async function getRestrictions(client: OAuth2Client, next): Promise<TRestrictions> {
  if ((client.metadata as Metadata)?.restrictions) {
    return (client.metadata as Metadata).restrictions as TRestrictions;
  }
  // Read restrictions on every request to allow zero-downtime changes to conditions
  let contents;
  try {
    contents = await new Promise((resolve, reject) =>
      readFile(
        "/config/restrictions.json",
        {
          encoding: "utf8"
        },
        (err, data) => (err ? reject(err) : resolve(data))
      )
    );
  } catch (error) {
    console.error(error);
    next(error);
    return;
  }

  const restrictionSet = JSON.parse(contents);
  const clientRestrictions = restrictionSet[client.client_id];

  return clientRestrictions as TRestrictions;
}

async function balanceOf(contract: ethers.Contract, address: TAddress) {
  let decimals = 18; // 18 is default in most tokens

  try {
    // For contracts without `decimals` function this will throw
    decimals = await contract.functions.decimals();
  } catch (error) {
    console.error(error);
  }

  let final = 0;

  try {
    const result = await contract.functions.balanceOf(address)
    if (result.length === 1) {
      const balance = ethers.BigNumber.from(result[0]);
      const a = ethers.BigNumber.from(10).pow(ethers.BigNumber.from(decimals));
      final = balance.div(a).toNumber();
    }
  } catch (error) {
    console.error(error);
  }

  return final;
}

function getContract(tokenAddress) {
  return new ethers.Contract(
    tokenAddress,
    TokenABI,
    provider
  )
}

function getAliases(contractAliases: TContractAliases) {
  return Object.entries(contractAliases).map((entry) => {
    const [name, tokenAddress] = (entry as [TContractAlias, TContractAddress]);
    return {
      name,
      contract: getContract(tokenAddress)
    };
  });
}

async function checkRestriction(restriction: TRestriction, address: TAddress) {
  const parser = mathParser();
  const data = {};

  if (restriction.contractAliases) {
    const aliases = getAliases(restriction.contractAliases);

    for (const alias of aliases) {
      const key = `${alias.name}balanceOf`;
      const value = await balanceOf(alias.contract, address);
      data[key] = value;
      parser.set(key, value);
    }
  }

  if (restriction.tokenAddress) {
    const key = `balanceOf`;
    const value = await balanceOf(getContract(restriction.tokenAddress), address);
    data[key] = value;
    parser.set(key, value);
  }

  const result: Boolean = parser.evaluate(restriction.condition);

  return {
    restriction,
    result,
    data,
  };
}

function checkRestrictionFor(recoveredAddress: TAddress) {
  return function (value: TRestriction) {
    return checkRestriction(value, recoveredAddress);
  }
}

export async function checkRestrictions(clientRestrictions: TRestrictions, recoveredAddress: TAddress): Promise<TCheckResults> {
  return await Promise.all(clientRestrictions.map(checkRestrictionFor(recoveredAddress)))
}
