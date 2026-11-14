import { Bookmark, Menu, Search } from 'lucide-react'
import costarLogo from './assets/costar-logo.svg'
import { isSortKey, SORTS, type SortKey } from './property'

type Props = {
  types: string[]
  type: string | null
  onType: (type: string | null) => void
  sort: SortKey
  onSort: (sort: SortKey) => void
  onFrame: () => void
  savedCount: number
  savedOnly: boolean
  onSavedOnly: (savedOnly: boolean) => void
}

export function Header({ types, type, onType, sort, onSort, onFrame, savedCount, savedOnly, onSavedOnly }: Props) {
  return (
    <header className="header">
      <div className="header-slot">
        <div className="logo">
          <span className="wordmark">propstar</span>
          <span className="byline">
            by <img src={costarLogo} width={47} height={13} alt="CoStar" />
          </span>
        </div>
      </div>

      <div className="filter-pill">
        <span className="segment">Los Angeles</span>
        <span className="divider" />
        <select className="segment" aria-label="Property type" value={type ?? ''} onChange={(e) => onType(e.target.value || null)}>
          <option value="">Any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="divider" />
        <select className="segment" aria-label="Sort" value={sort} onChange={(e) => isSortKey(e.target.value) && onSort(e.target.value)}>
          {Object.entries(SORTS).map(([key, { label }]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button className="circle search" aria-label="Frame these properties on the map" onClick={onFrame}>
          <Search size={16} />
        </button>
      </div>

      <div className="header-slot end">
        <button className="header-pill" aria-pressed={savedOnly} onClick={() => onSavedOnly(!savedOnly)}>
          <Bookmark size={14} className={savedOnly ? undefined : 'muted'} />
          Saved{savedCount > 0 ? ` · ${savedCount}` : ''}
        </button>
        <div className="header-pill account" aria-hidden>
          <Menu size={16} />
          <span className="avatar">FM</span>
        </div>
      </div>
    </header>
  )
}
