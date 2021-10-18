const ConnectToInjected = async () => {
  let provider = null;
  if (typeof window.ethereum !== 'undefined') {
    provider = window.ethereum;
    if (typeof provider.request === 'function') {
      try {
        await provider.request({ method: 'eth_requestAccounts' })
      } catch (error) {
        if (error.code === 4001) {
          throw new Error("User Rejected");
        }
        throw error;
      }
    } else {
      provider.enable()
    }
  } else if (window.web3) {
    provider = window.web3.currentProvider;
  } else {
    throw new Error("No Web3 Provider found");
  }
  return provider;
};

export default ConnectToInjected;
