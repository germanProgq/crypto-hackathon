// Wallet strategy interface supporting address-per-user and memo/tag attribution.
import type { WalletStrategy } from "../../shared/storage/mongoSchemas.js";

export interface DepositAddressRequest {
  userId: string;
  currency: string;
}

export interface DepositAddressResult {
  address: string;
  memo?: string;
  strategy: WalletStrategy;
}

export interface WalletStrategyProvider {
  getStrategy(): WalletStrategy;
  generateDepositAddress(request: DepositAddressRequest): Promise<DepositAddressResult>;
  verifyAddress(address: string, currency: string): boolean;
}

export class AddressPerUserStrategy implements WalletStrategyProvider {
  private readonly derivationPath: string;
  private readonly masterPublicKey: string;

  constructor(derivationPath: string, masterPublicKey: string) {
    this.derivationPath = derivationPath;
    this.masterPublicKey = masterPublicKey;
  }

  getStrategy(): WalletStrategy {
    return "address_per_user";
  }

  async generateDepositAddress(request: DepositAddressRequest): Promise<DepositAddressResult> {
    const userIdHash = hashUserId(request.userId);
    const childIndex = userIdHash % 2147483647;
    const derivedAddress = await deriveAddress(
      this.masterPublicKey,
      this.derivationPath,
      childIndex,
      request.currency
    );

    return {
      address: derivedAddress,
      strategy: "address_per_user"
    };
  }

  verifyAddress(address: string, currency: string): boolean {
    return validateCryptoAddress(address, currency);
  }
}

export class MemoTagStrategy implements WalletStrategyProvider {
  private readonly hotWalletAddress: string;

  constructor(hotWalletAddress: string) {
    this.hotWalletAddress = hotWalletAddress;
  }

  getStrategy(): WalletStrategy {
    return "memo_tag";
  }

  async generateDepositAddress(request: DepositAddressRequest): Promise<DepositAddressResult> {
    const memo = generateMemoTag(request.userId);

    return {
      address: this.hotWalletAddress,
      memo,
      strategy: "memo_tag"
    };
  }

  verifyAddress(address: string, currency: string): boolean {
    return validateCryptoAddress(address, currency) && address === this.hotWalletAddress;
  }
}

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function generateMemoTag(userId: string): string {
  const hash = hashUserId(userId);
  return hash.toString(36).toUpperCase().padStart(8, "0");
}

async function deriveAddress(
  masterPublicKey: string,
  derivationPath: string,
  childIndex: number,
  currency: string
): Promise<string> {
  const deterministicHash = `${masterPublicKey}:${derivationPath}:${childIndex}:${currency}`;
  let hash = 0;
  for (let i = 0; i < deterministicHash.length; i++) {
    const char = deterministicHash.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const addressHash = Math.abs(hash).toString(16).padStart(40, "0");

  if (currency === "BTC") {
    return `bc1q${addressHash.substring(0, 39)}`;
  }

  if (currency === "ETH" || currency === "USDT") {
    return `0x${addressHash.substring(0, 40)}`;
  }

  return `${currency.toLowerCase()}1${addressHash.substring(0, 39)}`;
}

function validateCryptoAddress(address: string, currency: string): boolean {
  if (!address || address.trim().length === 0) {
    return false;
  }

  if (currency === "BTC") {
    return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
  }

  if (currency === "ETH" || currency === "USDT") {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  return address.length >= 26 && address.length <= 64;
}

export function createWalletStrategy(
  strategy: WalletStrategy,
  options: {
    derivationPath?: string;
    masterPublicKey?: string;
    hotWalletAddress?: string;
  }
): WalletStrategyProvider {
  if (strategy === "address_per_user") {
    if (!options.derivationPath || !options.masterPublicKey) {
      throw new Error("Address-per-user strategy requires derivationPath and masterPublicKey");
    }
    return new AddressPerUserStrategy(options.derivationPath, options.masterPublicKey);
  }

  if (strategy === "memo_tag") {
    if (!options.hotWalletAddress) {
      throw new Error("Memo/tag strategy requires hotWalletAddress");
    }
    return new MemoTagStrategy(options.hotWalletAddress);
  }

  throw new Error(`Unknown wallet strategy: ${strategy}`);
}
