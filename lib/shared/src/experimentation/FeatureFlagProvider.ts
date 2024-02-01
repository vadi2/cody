import { graphqlClient, type SourcegraphGraphQLAPIClient } from '../sourcegraph-api/graphql'
import { isError } from '../utils'

export enum FeatureFlag {
    // This flag is only used for testing the behavior of the provider and should not be used in
    // product code
    TestFlagDoNotUse = 'test-flag-do-not-use',

    // Enable both-client side and server-side tracing
    CodyAutocompleteTracing = 'cody-autocomplete-tracing',
    // This flag is used to track the overall eligibility to use the StarCoder model. The `-hybrid`
    // suffix is no longer relevant
    CodyAutocompleteStarCoderHybrid = 'cody-autocomplete-default-starcoder-hybrid',
    // Force all StarCoder traffic (controlled by the above flag) to point to the 16b model.
    CodyAutocompleteStarCoder16B = 'cody-autocomplete-default-starcoder-16b',
    // Enables the bfg-mixed context retriever that will combine BFG with the default local editor
    // context.
    CodyAutocompleteContextBfgMixed = 'cody-autocomplete-context-bfg-mixed',
    // Enables the new-jaccard-similarity context strategy that can find more than one match per
    // open file and includes matches from the same file.
    CodyAutocompleteContextNewJaccardSimilarity = 'cody-autocomplete-new-jaccard-similarity',
    // Enable latency adjustments based on accept/reject streaks
    CodyAutocompleteUserLatency = 'cody-autocomplete-user-latency',
    // Dynamically decide wether to show a single line or multiple lines for completions.
    CodyAutocompleteDynamicMultilineCompletions = 'cody-autocomplete-dynamic-multiline-completions',
    // Continue generations after a single-line completion and use the response to see the next line
    // if the first completion is accepted.
    CodyAutocompleteHotStreak = 'cody-autocomplete-hot-streak',
    // Connects to Cody Gateway directly and skips the Sourcegraph instance hop for completions
    CodyAutocompleteFastPath = 'cody-autocomplete-fast-path',
    // Trigger only one request for every multiline completion instead of three.
    CodyAutocompleteSingleMultilineRequest = 'cody-autocomplete-single-multiline-request',

    // Enable Cody PLG features on JetBrains
    CodyProJetBrains = 'cody-pro-jetbrains',

    // use-ssc-for-cody-subscription is a feature flag that enables the use of SSC as the source of truth for Cody subscription data.
    UseSscForCodySubscription = 'use-ssc-for-cody-subscription',

    // cody-pro-trial-ended is a feature flag that indicates if the Cody Pro "Free Trial"  has ended.
    // (Enabling users to use Cody Pro for free for 3-months starting in late Q4'2023.)
    CodyProTrialEnded = 'cody-pro-trial-ended',

    // A feature flag to test potential chat experiments. No functionality is gated by it.
    CodyChatMockTest = 'cody-chat-mock-test',
}

const ONE_HOUR = 60 * 60 * 1000

export class FeatureFlagProvider {
    // The first key maps to the endpoint so that we do never cache the wrong flag for different
    // endpoints
    private featureFlags: Record<string, Record<string, boolean>> = {}
    private lastUpdated = 0

    private subscriptions: Map<
        string, // ${endpoint}#${prefix filter}
        { lastSnapshot: string; callbacks: Set<() => void> }
    > = new Map()
    // When we have at least one subscription, ensure that we also periodically refresh the flags
    private nextRefreshTimeout: NodeJS.Timeout | number | undefined = undefined

    constructor(private apiClient: SourcegraphGraphQLAPIClient) {}

    public getFromCache(
        flagName: FeatureFlag,
        endpoint: string = this.apiClient.endpoint
    ): boolean | undefined {
        const now = Date.now()
        if (now - this.lastUpdated > ONE_HOUR) {
            // Cache expired, refresh
            void this.refreshFeatureFlags()
        }

        return this.featureFlags[endpoint]?.[flagName]
    }

    public async evaluateFeatureFlag(flagName: FeatureFlag): Promise<boolean> {
        const endpoint = this.apiClient.endpoint
        if (process.env.BENCHMARK_DISABLE_FEATURE_FLAGS) {
            return false
        }

        const cachedValue = this.getFromCache(flagName, endpoint)
        if (cachedValue !== undefined) {
            return cachedValue
        }

        const value = await this.apiClient.evaluateFeatureFlag(flagName)
        if (!this.featureFlags[endpoint]) {
            this.featureFlags[endpoint] = {}
        }
        this.featureFlags[endpoint][flagName] = value === null || isError(value) ? false : value
        this.notifyFeatureFlagChanged()
        return this.featureFlags[endpoint][flagName]
    }

    public async syncAuthStatus(): Promise<void> {
        this.featureFlags = {}
        await this.refreshFeatureFlags()
    }

    private async refreshFeatureFlags(): Promise<void> {
        const endpoint = this.apiClient.endpoint
        const data = await this.apiClient.getEvaluatedFeatureFlags()
        this.featureFlags[endpoint] = isError(data) ? {} : data
        this.lastUpdated = Date.now()
        this.notifyFeatureFlagChanged()

        if (this.nextRefreshTimeout) {
            clearTimeout(this.nextRefreshTimeout)
            this.nextRefreshTimeout = undefined
        }
        if (this.subscriptions.size > 0) {
            this.nextRefreshTimeout = setTimeout(() => this.refreshFeatureFlags(), ONE_HOUR)
        }
    }

    // Allows you to subscribe to a change event that is triggered when feature flags with a
    // predefined prefix are updated. Can be used to sync code that only queries flags at startup
    // to outside changes.
    public onFeatureFlagChanged(
        endpoint: string,
        prefixFilter: string,
        callback: () => void
    ): () => void {
        const key = endpoint + '#' + prefixFilter
        const subscription = this.subscriptions.get(key)
        if (subscription) {
            subscription.callbacks.add(callback)
            return () => subscription.callbacks.delete(callback)
        }

        this.subscriptions.set(prefixFilter, {
            lastSnapshot: this.computeFeatureFlagSnapshot(endpoint, prefixFilter),
            callbacks: new Set([callback]),
        })

        if (!this.nextRefreshTimeout) {
            this.nextRefreshTimeout = window.setTimeout(() => {
                this.nextRefreshTimeout = undefined
                void this.refreshFeatureFlags()
            }, ONE_HOUR)
        }

        return () => {
            const sub = this.subscriptions.get(key)
            if (sub) {
                sub.callbacks.delete(callback)
                if (sub.callbacks.size === 0) {
                    this.subscriptions.delete(key)
                }

                if (this.subscriptions.size === 0 && this.nextRefreshTimeout) {
                    clearTimeout(this.nextRefreshTimeout)
                    this.nextRefreshTimeout = undefined
                }
            }
        }
    }

    private notifyFeatureFlagChanged(): void {
        // loop over the feature flags and see if they were changed
        for (const key of this.subscriptions) {
            const endpoint = key[0].split('#')[0]
            const prefixFilter = key[0].split('#')[1]

            const currentSnapshot = this.computeFeatureFlagSnapshot(endpoint, prefixFilter)
            if (currentSnapshot !== key[1].lastSnapshot) {
                key[1].lastSnapshot = currentSnapshot
                for (const callback of key[1].callbacks) {
                    callback()
                }
            }
        }
    }

    private computeFeatureFlagSnapshot(endpoint: string, prefixFilter: string): string {
        const featureFlags = this.featureFlags[endpoint]
        if (!featureFlags) {
            return ''
        }
        const keys = Object.keys(featureFlags)
        const filteredKeys = keys.filter(key => key.startsWith(prefixFilter))
        const filteredFeatureFlags = filteredKeys.reduce((acc: any, key) => {
            acc[key] = featureFlags[key]
            return acc
        }, {})
        return JSON.stringify(filteredFeatureFlags)
    }
}

export const featureFlagProvider = new FeatureFlagProvider(graphqlClient)
