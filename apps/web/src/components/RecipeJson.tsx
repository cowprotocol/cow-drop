import { compileRecipe, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'

/**
 * Import/export of the recipe file.
 *
 * This is the part worth demoing: export the file, reload, import it, and the same address comes
 * back — because the address is derived from the recipe rather than stored anywhere. Nothing about a
 * drop needs a server or a database.
 */
export function RecipeJson({
  recipe,
  address,
  onImport,
  onError,
}: {
  recipe: DropRecipeJson
  address: Address
  onImport: (recipe: DropRecipeJson) => void
  onError: (message: string) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(recipe, null, 2))
  const [dirty, setDirty] = useState(false)

  // Track the form while the user has not started hand-editing.
  useEffect(() => {
    if (!dirty) setText(JSON.stringify(recipe, null, 2))
  }, [recipe, dirty])

  const apply = () => {
    try {
      const parsed = JSON.parse(text) as DropRecipeJson
      // Compile before handing it up, so a bad file surfaces here rather than as a broken address.
      compileRecipe(parsed)
      onImport(parsed)
      setDirty(false)
    } catch (cause) {
      onError(`Could not import recipe: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${recipe.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${address.slice(0, 10)}.drop.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const upload = (file: File | undefined) => {
    if (!file) return
    void file.text().then((contents) => {
      setText(contents)
      setDirty(true)
    })
  }

  return (
    <div className="recipe-json">
      <textarea
        value={text}
        spellCheck={false}
        rows={18}
        onChange={(event) => {
          setText(event.target.value)
          setDirty(true)
        }}
      />
      <div className="actions">
        <button onClick={apply} disabled={!dirty}>
          Apply edits
        </button>
        <button onClick={download}>Download .drop.json</button>
        <label className="upload">
          Import file
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => upload(event.target.files?.[0])}
          />
        </label>
      </div>
    </div>
  )
}
