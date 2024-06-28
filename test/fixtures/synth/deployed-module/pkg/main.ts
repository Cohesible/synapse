import { Bucket } from 'synapse:srl/storage'

const b = new Bucket()

export function createClient() {
    function get(key: string) {
        return b.get(key, 'utf-8')
    }

    function put(key: string, data: string) {
        return b.put(key, data)
    }

    return { get, put }
}
