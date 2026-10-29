# @profullstack/b1dz

The `b1dz` command: terminal client for [b1dz.com](https://b1dz.com), the crypto
arbitrage terminal. Live dashboard (TUI), backtests, spread audits, a multi-venue
quote observer and account setup.

## Install

```sh
curl -fsSL https://b1dz.com/install.sh | sh
```

or with a package manager (Node >= 22, or Bun):

```sh
npm install -g @profullstack/b1dz
bun add -g @profullstack/b1dz
```

The installer only installs the CLI. It never asks for, reads or writes exchange
keys or wallet secrets.

## Get started

```sh
b1dz signup        # or: b1dz login
b1dz setup         # guided walkthrough; you enter exchange keys yourself
b1dz tui           # live dashboard
b1dz --help        # every command
```

`b1dz setup` stores your settings in your b1dz.com account over HTTPS. Use
read/trade-only exchange keys with withdrawals disabled. Your session is kept in
`~/.config/b1dz/credentials.json` (mode 600).

Set `B1DZ_API_URL` to point the CLI at another b1dz server (default
`https://b1dz.com`).

The trading daemon (`b1dzd`) is not part of this package; it runs from the
[source repository](https://github.com/profullstack/b1dz.com) (see
`apps/daemon/README.md`).

Trading cryptocurrency involves substantial risk. b1dz automates execution; it
does not guarantee profit.
