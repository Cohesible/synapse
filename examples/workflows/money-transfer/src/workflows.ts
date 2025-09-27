import { BankingService } from './banking'
import { checkpoint, createWorkflowService } from '@cohesible/workflows'

interface PaymentDetails {
    amount: number
    sourceAccount: string
    targetAccount: string
    referenceId: string
}

const withdraw = checkpoint(async function withdraw(details: PaymentDetails): Promise<string> {
    console.log(
      `Withdrawing $${details.amount} from account ${details.sourceAccount}.\n\n`
    )
    const bank1 = new BankingService('bank1.example.com')
    return await bank1.withdraw(
      details.sourceAccount,
      details.amount,
      details.referenceId
    );
})

const deposit = checkpoint(async function deposit(details: PaymentDetails): Promise<string> {
    console.log(
      `Depositing $${details.amount} into account ${details.targetAccount}.\n\n`
    )
    const bank2 = new BankingService('bank2.example.com')
    return await bank2.deposit(
      details.targetAccount,
      details.amount,
      details.referenceId
    );
  })

const refund = checkpoint(async function refund(details: PaymentDetails) {
    console.log(
        `Refunding $${details.amount} to account ${details.sourceAccount}.\n\n`
    )
    const bank1 = new BankingService('bank1.example.com')

    return await bank1.deposit(
        details.sourceAccount,
        details.amount,
        details.referenceId
    )
})

class ApplicationFailure extends Error {}

async function moneyTransfer(details: PaymentDetails): Promise<string> {
  let withdrawResult: string
  try {
    withdrawResult = await withdraw(details)
  } catch (withdrawErr) {
    throw new ApplicationFailure(`Withdrawal failed. Error: ${withdrawErr}`)
  }

  let depositResult: string
  try {
    depositResult = await deposit(details)
  } catch (depositErr) {
    // The deposit failed; try to refund the money.
    let refundResult
    try {
      refundResult = await refund(details)
      throw new ApplicationFailure(`Failed to deposit money into account ${details.targetAccount}. Money returned to ${details.sourceAccount}. Cause: ${depositErr}.`)
    } catch (refundErr) {
      throw new ApplicationFailure(`Failed to deposit money into account ${details.targetAccount}. Money could not be returned to ${details.sourceAccount}. Cause: ${refundErr}.`)
    }
  }
  return `Transfer complete (transaction IDs: ${withdrawResult}, ${depositResult})`
}

const workflows = createWorkflowService()
const moneyTransferWorkflow = workflows.register(moneyTransfer)

export async function main() {
    const details: PaymentDetails = {
        amount: 400,
        sourceAccount: '85-150',
        targetAccount: '43-812',
        referenceId: '12345',
    }

    try {
        const resp = await moneyTransferWorkflow.run('pay-invoice-804', details)
        console.log(resp)
    } finally {
        const bank1 = new BankingService('bank1.example.com')
        const bank2 = new BankingService('bank2.example.com')
        console.log('acc1 balance:', await bank1.getBalance('85-150'))
        console.log('acc2 balance:', await bank2.getBalance('43-812'))
    }
}

