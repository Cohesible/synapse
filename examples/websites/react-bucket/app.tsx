import { Suspense, useRef } from 'react'
import { Bucket } from 'synapse:srl/storage'
import { createWebsite } from '@cohesible/synapse-react'
import { useServer, openBrowser } from '@cohesible/synapse-websites'

const website = createWebsite()
const bucket = new Bucket()

const getData = (key: string) => {
    return bucket.get(key, 'utf-8').catch(e => {
        return (e as any).message
    })
}

function BucketContents(props: { bucketKey: string }) {
    const data = useServer(getData, props.bucketKey)

    return <pre>{data}</pre>
}

function BucketPage(props: { bucketKey: string }) {
    return (
        <div>
            <Suspense fallback={<div>loading</div>}>
                <BucketContents bucketKey={props.bucketKey}/>
            </Suspense>
        </div>
    )
}

const addData = website.bind(async (key: string, data: string) => {
    await bucket.put(key, data)
})

function BucketForm() {
    const keyRef = useRef<HTMLInputElement>()
    const valueRef = useRef<HTMLInputElement>()

    function submit() {
        const key = keyRef.current.value
        const value = valueRef.current.value

        addData(key, value).then(() => {
            window.location = window.location
        })
    }

    return (
        <div>
            <label>
                Key
                <input type='text' ref={keyRef}></input>
            </label>
            <label>
                Value
                <input type='text' ref={valueRef}></input>
            </label>
            <button onClick={submit} style={{ marginLeft: '10px' }}>Add Item</button>
        </div>
    )
}

async function getItems() {
    return await bucket.list()
}

const doDelete = website.bind((key: string) => bucket.delete(key))

function BucketItem(props: { bucketKey: string }) {
    const k = props.bucketKey

    function deleteItem() {
        doDelete(k).then(() => {
            window.location = window.location
        })
    }

    return (
        <li>
            <div style={{ display: 'flex', maxWidth: '250px', marginBottom: '10px' }}>
                <a href={`/bucket/${k}`} style={{ flex: 'fit-content', alignSelf: 'flex-start' }}>{k}</a>
                <button onClick={deleteItem} style={{ alignSelf: 'flex-end' }}>Delete</button>
            </div>
        </li>
    )
}

function ItemList() {
    const items = useServer(getItems)

    if (items.length === 0) {
        return <div><b>There's nothing in the bucket!</b></div>
    }

    return (
        <ul>
            {items.map(k => <BucketItem key={k} bucketKey={k}/>)}
        </ul>
    )
}

function HomePage() {
    return (
        <div>
            <BucketForm></BucketForm>
            <br></br>
            <Suspense fallback='loading'>
                <ItemList/>
            </Suspense>
        </div>
    )
}

website.page('/', HomePage)
website.page('/bucket/{bucketKey}', BucketPage)

export async function main() {
    openBrowser(website.url)
}
