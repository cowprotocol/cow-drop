import { CopyBlock } from '../components/CopyBlock.js'

/**
 * The SDK, for someone who would rather do this in code than in the form.
 *
 * Hand-written snippets rather than the package's `API.md` rendered: markdown needs a parser, and this
 * app deliberately has no dependency it does not need. The trade is drift, so the list is kept short
 * and each group points at `API.md` for the full reference.
 */

const QUICKSTART = `import { compileRecipe, buildActivateTx, twapOnArrival } from '@cowprotocol/cow-drop-sdk'

// 1. Describe what should happen to the money.
const recipe = twapOnArrival({
  chainId: 100,
  owner: '0xYourAddress',            // can always recover the funds
  sellToken: WXDAI,
  buyToken: COW,
  parts: 12,
  partDuration: 3600,                // one part per hour
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  minAmount: 1000n * 10n ** 18n,     // refuse to start on a part-delivered balance
})

// 2. Get the address. Nothing is deployed yet; this is pure computation.
const { address, setupData, deployment } = compileRecipe(recipe)

// 3. Send funds to \`address\` — bridge, exchange withdrawal, plain transfer.

// 4. Anyone can then run it. No signature, no privileged sender.
const tx = buildActivateTx({ deployment, owner: recipe.owner, setupData })
await walletClient.sendTransaction(tx)`

const DESCRIBE = `import { compileRecipe, describeRecipe } from '@cowprotocol/cow-drop-sdk'

// The inverse of compiling: committed bytes back to named steps, decoded arguments and warnings.
// This is what the "What the address commits to" panel renders, and reading it *is* the safeguard —
// activation is permissionless and unsigned, so nothing else checks what you are funding.
const { setupData, deployment } = compileRecipe(recipe)
const described = describeRecipe(setupData, deployment)

for (const step of described.steps) {
  console.log(step.name, step.args)      // an unrecognised call is named as such, never guessed at
}
console.log(described.warnings)          // delegatecall to a non-step contract, allowFailure, ...`

const RESCUE = `import { buildRescueForState } from '@cowprotocol/cow-drop-sdk'

// Owner-only, and it needs the same recipe bytes activation does — only their hash is on-chain.
// Which path applies depends on whether the shed exists yet, so let the SDK decide.
const tx = buildRescueForState({
  deployment,
  owner,
  setupData,
  deployed,                 // false -> deploy without setup; true -> sweep directly
  sweep: [{ token, to: owner }],
})`

const ADDRESS = `import { deriveDropAddress, encodeRecipe, saltOf } from '@cowprotocol/cow-drop-sdk'

// The address is a hash commitment, so it can be computed with nothing on-chain and no network call.
const setupData = encodeRecipe(recipe)
const address = deriveDropAddress({ deployment, owner, setupData })

// Change one byte of setupData and this is a different address. That is the whole security model.
const salt = saltOf({ deployment, owner, setupData })`

export function SdkTab() {
  return (
    <>
      <section>
        <h2>@cowprotocol/cow-drop-sdk</h2>
        <p className="hint">
          Compile a recipe, get an address, build the activation transaction. TypeScript, and{' '}
          <code>viem</code> is its only runtime dependency. Everything this page does, it does through
          this SDK — the form is a caller, not a privileged one.
        </p>
        <CopyBlock
          label="The 30-second version"
          hint="A recipe in, an address out, and a transaction anyone can send."
          command={QUICKSTART}
        />
      </section>

      <section>
        <h2>Addresses and encoding</h2>
        <p className="hint">
          Pure computation: no RPC, no deployment, nothing to wait for. Useful for showing someone an
          address before anything exists at it.
        </p>
        <CopyBlock label="Derive an address by hand" command={ADDRESS} />
      </section>

      <section>
        <h2>Reading a recipe back</h2>
        <p className="hint">
          The direction that matters most before funding: what do these committed bytes actually do? A
          step the SDK cannot name is reported as an unrecognised call rather than rendered as if it were
          understood.
        </p>
        <CopyBlock label="Decode committed setupData" command={DESCRIBE} />
      </section>

      <section>
        <h2>Rescue</h2>
        <p className="hint">
          For a drop whose recipe can never succeed. Two owner-only paths, neither needing a signature —
          but both needing the recipe bytes, which is why the recipe file is the key rather than a
          convenience.
        </p>
        <CopyBlock label="Recover the funds" command={RESCUE} />
      </section>

      <section>
        <h2>The rest</h2>
        <p className="hint">
          Templates (<code>swapOnArrival</code>, <code>twapOnArrival</code>, <code>stopLossOnArrival</code>
          ), the twelve <code>steps.*</code> builders for anything the templates do not cover, order
          hashing (<code>orderUidFor</code>, <code>hashCowOrder</code>), <code>parseOrderPlacement</code>{' '}
          and <code>toOrderBookPayload</code> for the pre-sign path, and the generated per-chain
          deployment constants. The full reference is <code>packages/sdk/API.md</code>.
        </p>
        <p className="hint">
          One thing worth knowing before you start: a recipe pins its <strong>generation</strong>, and it
          defaults to 1 rather than the latest. A redeploy is a new generation with new addresses for the
          same recipe, never an update in place — so changing it changes the address.
        </p>
      </section>
    </>
  )
}
