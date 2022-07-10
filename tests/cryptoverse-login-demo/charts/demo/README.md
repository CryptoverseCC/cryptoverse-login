# Setup

Make sure your microk8s cluster can reach the internet

```bash
$ sudo iptables -P FORWARD ACCEPT
...
```

## Install cert-manager

```bash
$ helm repo add jetstack https://charts.jetstack.io
...
$ helm repo update
...
$ kubectl create namespace cert-manager
...
$ helm install cert-manager jetstack/cert-manager --namespace cert-manager --version v1.0.3 --set installCRDs=true
...
```

### Verify

```bash
$ kubectl get pods --namespace cert-manager
...
```
