declare const __COMMIT__: string

const REPO = 'https://github.com/cowprotocol/cow-drop'

/** The commit this page was built from, linked to it on GitHub. */
export function BuildInfo() {
  if (!__COMMIT__) return null
  return (
    <footer className="build-info">
      <a href={`${REPO}/commit/${__COMMIT__}`} target="_blank" rel="noreferrer">
        {__COMMIT__.slice(0, 7)}
      </a>
    </footer>
  )
}
