import { ServiceProvider, getServiceRegistry } from '../../deploy/registry'
import type { SecretProviderProps } from '../../runtime/modules/core'
import { memoize } from '../../utils'


export function createInmemSecretService() {
    const providers = new Map<string, SecretProviderProps>()

    async function getSecret(secretType: string) {
        const provider = [...providers.values()].find(x => x.secretType === secretType)
        if (!provider) {
            throw new Error(`No secret provider found: ${secretType}`)
        }

        return await provider.getSecret()
    }

    function _getBinding(): ServiceProvider<SecretProviderProps> {
        return {
            kind: 'secret-provider',
            load: (id, config) => void providers.set(id, config),
            unload: (id) => void providers.delete(id),
        }
    }

    return {
        getSecret,
        _getBinding,
    }
}

export const getInmemSecretService = memoize(createInmemSecretService)

// getServiceRegistry().registerServiceProvider(
//     getInmemSecretService()._getBinding()
// )