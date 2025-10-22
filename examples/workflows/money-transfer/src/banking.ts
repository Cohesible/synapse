import { Table } from 'synapse:srl/storage'
import { defineResource } from 'synapse:core'
import { SimpleLock } from 'synapse:srl/compute'
import { suite, test, expectEqual } from 'synapse:test'

interface Account {
  readonly id: string
  balance: number
}

class Bank {
  private readonly accounts = new Table<Account['id'], Account>()
  private readonly accountsLock = new SimpleLock()

  async findAccount(accountNumber: string) {
    return this.accounts.get(accountNumber)
  }

  async getAccountBalance(accountNumber: string) {
    const acc = await this.findAccount(accountNumber)
    if (!acc) {
      throw new InvalidAccountError()
    }

    return acc.balance
  }

  async addAccount(account: Account) {
    await this.accounts.set(account.id, account)
  }

  async deleteAccount(accountNumber: string) {
    await this.accounts.delete(accountNumber)
  }

  private async _updateBalance(accountNumber: string, delta: number) {
    const acc = await this.findAccount(accountNumber)
    if (!acc) {
      throw new InvalidAccountError()
    }

    if (delta < 0 && -delta > acc.balance) {
      throw new InsufficientFundsError()
    }

    const newBalance = acc.balance + delta
    await this.accounts.set(acc.id, { ...acc, balance: newBalance })

    return { balance: newBalance }
  }

  async updateBalance(accountNumber: string, delta: number) {
    // note: this lock does not guarantee isolation in the critical section beyond the duration provided 
    // due to the force-release functionality. A general purpose distributed lock that's also robust towards
    // process crashes w/o a timeout would need a supervisor layer, which we currently do not have.
    await this.accountsLock.lock(accountNumber, 5_000)
    try {
      return await this._updateBalance(accountNumber, delta)
    } finally {
      await this.accountsLock.unlock(accountNumber)
    }
  }
}

suite('Bank', () => {
  const b = new Bank()

  test('guards against multiple concurrent writers', async () => {
    const acc: Account = { id: 'foo', balance: 1000 }
    await b.addAccount(acc)
    const results = await Promise.all([
      b.updateBalance(acc.id, -1000).catch(err => err),
      b.updateBalance(acc.id, -1000).catch(err => err),
    ])

    const errors = results.filter(x => x instanceof Error)
    if (errors.length === 2) {
      console.log(errors)
      throw new Error('two errors :(')
    }

    expectEqual(results.filter(x => x instanceof InsufficientFundsError).length, 1)

    const balance = await b.getAccountBalance(acc.id)
    expectEqual(balance, 0)
  })
})

export class InvalidAccountError extends Error {
  constructor() {
    super('Account number supplied is invalid')
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient Funds')
  }
}

const bank1 = new Bank()
const bank2 = new Bank()

class AccountResource extends defineResource({
  create: async (bank: Bank, id: string, balance: number) => {
    await bank.addAccount({ id, balance })
    return { id }
  },
  update: async (state, bank, id, balance) => {
    if (state.id === id) {
      return state
    }

    await bank.deleteAccount(state.id)
    await bank.addAccount({ id, balance })

    return { id }
  },
  delete: async (state, bank) => {
    await bank.deleteAccount(state.id)
  },
}) { }

const acc1 = new AccountResource(bank1, '85-150', 2000)
const acc2 = new AccountResource(bank2, '43-812', 0)
const acc3 = new AccountResource(bank1, '85-150-1', 10_000) // This could be a savings account for the owner of 85-150

export class BankingService {
  private readonly bank: Bank

  constructor(hostname: string) {
    switch (hostname) {
      case 'bank1.example.com':
        this.bank = bank1
        break
      case 'bank2.example.com':
        this.bank = bank2
        break
      default:
        throw new Error(`unknown hostname: ${hostname}`)
    }
  }

  generateTransactionID(prefix: string, length: number): string {
    let result = prefix
    const characters = '0123456789';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(
        Math.floor(Math.random() * characters.length)
      )
    }
    return result
  }

  async withdraw(
    sourceAccount: string,
    amount: number,
    referenceId: string
  ): Promise<string> {
    await this.bank.updateBalance(sourceAccount, -amount)

    return this.generateTransactionID('W', 10)
  }

  async deposit(
    targetAccount: string,
    amount: number,
    referenceId: string
  ): Promise<string> {
    await this.bank.updateBalance(targetAccount, amount)

    return this.generateTransactionID('D', 10)
  }

  async getBalance(targetAccount: string) {
    return this.bank.getAccountBalance(targetAccount)
  }
}
