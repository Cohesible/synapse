import { checkpoint, createWorkflowService } from '@cohesible/workflows'
import { Bucket, Table } from 'synapse:srl/storage'

const db = new Table<string, number>()

// A "checkpoint" is a function you want to execute _once_, to completion.
// 
// Checkpoint results are saved so that even if later code fails, we can 
// continue where we left off.
const setTimestamp = checkpoint(async (key: string) => {
    const timestamp = Date.now()
    await db.set(key, timestamp)

    return { timestamp }
})

const bucket = new Bucket()
const saveData = checkpoint(async (key: string, data: string) => {
    if (data === 'invalid') {
        throw new Error('Received invalid data')
    }

    await bucket.put(key, data)
})

// Checkpoints are only usable inside of other checkpoints and "workflows", which are
// simply root-level checkpoints tied to particular infrastructure.
// 
// We will be running our checkpoints on the infrastructure provided by `createWorkflowService`
const workflows = createWorkflowService()

// The function passed to `register` becomes a root-level checkpointed workflow.
// A workflow behaves just like any other function except that it respects checkpoints.
//
// Repeated runs of the same workflow job will execute the same code but will skip over
// previously successful checkpoints.
const saveTimeAndData = workflows.register(async (req: { key: string, data: string }) => {
    const result = await setTimestamp(req.key)
    await saveData(req.key, req.data)

    return result
})

export async function main() {
    // Checkpoints persist results for a given `workflowJobId`.
    //
    // This example fails at `saveData` when `data` is equal to 'invalid'
    // Try running this example with `synapse run` and note "current time"

    const workflowJobId = 'run-fail'
    const data = 'invalid'

    console.log('current time:  ', new Date().toISOString())
    console.log()

    try {
        const result = await saveTimeAndData.run(workflowJobId, { key: 'foo', data })
        console.log('timestamp:     ', new Date(result.timestamp).toISOString())
    } catch (e) {
        // Now change 'invalid' to 'not invalid' and run again
        //
        // You'll see that `timestamp` is _before_ "current time" because we already 
        // executed that step from our failed attempt.
        console.error('Workflow failed:\n', e)
    }
}