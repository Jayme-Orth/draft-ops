import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Settings, Users, Target, Zap, Flame, TrendingUp, AlertTriangle,
  Crown, Star, Trash2, Download, Upload, RefreshCw, Plus, X,
  ChevronDown, ChevronRight, Search, Edit2, Save, Eye, EyeOff,
  Activity, BarChart3, Clock, CircleAlert, CheckCircle2, Hexagon
} from 'lucide-react';

// ==================== STORAGE KEYS ====================
const KEYS = {
  settings: 'ff:settings',
  rankings: 'ff:rankings',
  adp: 'ff:adp',
  targets: 'ff:targets',
  draft: 'ff:draft',
  ui: 'ff:ui',
};

// ==================== DEFAULTS ====================
const DEFAULT_SETTINGS = {
  leagueName: 'League 1',
  numTeams: 12,
  myPick: 6,
  numRounds: 16,
  scoringFormat: 'Full PPR',
  activeAdp: 'adp1',
  adpLabels: { adp1: 'ADP 1', adp2: 'ADP 2', adp3: 'ADP 3' },
  activeRankings: 'rank1', // rank1, rank2, rank3, or aggregate
  rankingLabels: { rank1: 'Rankings 1', rank2: 'Rankings 2', rank3: 'Rankings 3', aggregate: 'Aggregate' },
  roster: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 },
  thresholds: { steal: 12, value: 6, reach: 6 },
  weights: { rosterNeed: 2, scarcity: 2, run: 1 },
};

// ==================== NAME MATCHING ====================
// Normalize player names for cross-source matching.
// Handles: punctuation, common suffixes (Jr/Sr/II/III/IV), apostrophes, periods, case.
const normalizeName = (name) => {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/['']/g, '')           // remove apostrophes
    .replace(/\./g, '')              // remove periods (A.J. → AJ)
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '') // strip suffixes
    .replace(/[^a-z0-9 ]/g, ' ')    // anything else not alphanumeric → space
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();
};

// Levenshtein distance for fuzzy matching when exact normalized match fails
const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

// Given a target name and a list of candidates, find the best match within tolerance.
// Returns { match, score } or null.
const findBestNameMatch = (target, candidates, pos = null) => {
  if (!target) return null;
  const normTarget = normalizeName(target);

  // Step 1: exact normalized match
  for (const c of candidates) {
    if (pos && c.pos && c.pos !== pos) continue;
    if (normalizeName(c.player) === normTarget) {
      return { match: c, score: 1.0, exact: true };
    }
  }

  // Step 2: fuzzy match — within distance/length threshold
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (pos && c.pos && c.pos !== pos) continue;
    const normCand = normalizeName(c.player);
    const dist = levenshtein(normTarget, normCand);
    // Threshold: distance must be <= 20% of the longer name length, and absolute <= 3
    const maxLen = Math.max(normTarget.length, normCand.length);
    if (dist < bestDist && dist <= Math.min(3, Math.floor(maxLen * 0.2))) {
      bestDist = dist;
      best = c;
    }
  }
  if (best) {
    const maxLen = Math.max(normTarget.length, normalizeName(best.player).length);
    return { match: best, score: 1 - (bestDist / maxLen), exact: false };
  }
  return null;
};

// ==================== HELPERS ====================
const loadStorage = async (key, fallback) => {
  try {
    const result = await window.storage.get(key);
    return result ? JSON.parse(result.value) : fallback;
  } catch {
    return fallback;
  }
};

const saveStorage = async (key, value) => {
  try {
    await window.storage.set(key, JSON.stringify(value));
  } catch (e) {
    console.error('Storage error:', e);
  }
};

const computeTeamForPick = (pickNum, numTeams) => {
  if (!numTeams || numTeams === 0) return 0;
  const round = Math.ceil(pickNum / numTeams);
  const pickInRound = ((pickNum - 1) % numTeams) + 1;
  return round % 2 === 1 ? pickInRound : numTeams - pickInRound + 1;
};

const computeMyNextPick = (currentPick, myPick, numTeams, numRounds, draft) => {
  for (let p = currentPick; p <= numTeams * numRounds; p++) {
    if (computeTeamForPick(p, numTeams) === myPick && !draft[p]) return p;
  }
  return null;
};

// Parse pasted rankings (tab-separated or comma-separated, with or without headers)
// Detect which column contains which field by header name
const detectColumns = (headerCells) => {
  const norm = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const cols = { player: -1, team: -1, pos: -1, overallRank: -1, posRank: -1, bye: -1, tier: -1, notes: -1 };

  headerCells.forEach((cell, idx) => {
    const c = norm(cell);
    if (cols.player === -1 && (c === 'player' || c === 'name' || c === 'playername')) cols.player = idx;
    else if (cols.team === -1 && (c === 'team' || c === 'tm' || c === 'nflteam')) cols.team = idx;
    else if (cols.pos === -1 && (c === 'position' || c === 'pos')) cols.pos = idx;
    else if (cols.overallRank === -1 && (c === 'rank' || c === 'overallrank' || c === 'overall' || c === 'rk' || c === 'ovr')) cols.overallRank = idx;
    else if (cols.posRank === -1 && (c === 'positionrank' || c === 'posrank' || c === 'positionalrank' || c === 'posrk')) cols.posRank = idx;
    else if (cols.bye === -1 && (c === 'bye' || c === 'byeweek' || c === 'byewk')) cols.bye = idx;
    else if (cols.tier === -1 && c === 'tier') cols.tier = idx;
    else if (cols.notes === -1 && (c === 'notes' || c === 'note' || c === 'comment' || c === 'comments')) cols.notes = idx;
  });

  return cols;
};

const parseRankings = (text) => {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  // Detect delimiter
  const firstLine = lines[0];
  const hasTab = firstLine.includes('\t');
  const delimiter = hasTab ? '\t' : ',';

  // Detect header
  const firstCells = firstLine.split(delimiter).map(c => c.trim().toLowerCase());
  const headerKeywords = ['player', 'name', 'rank', 'overall', 'position', 'pos', 'team', 'bye', 'tier'];
  const hasHeader = firstCells.some(c => headerKeywords.includes(c.replace(/[^a-z]/g, '')));

  let cols;
  let dataLines;
  if (hasHeader) {
    cols = detectColumns(firstLine.split(delimiter));
    dataLines = lines.slice(1);
  } else {
    // Fallback: assume original order Player, Team, Position, OverallRank, PosRank, Bye, Tier, Notes
    cols = { player: 0, team: 1, pos: 2, overallRank: 3, posRank: 4, bye: 5, tier: 6, notes: 7 };
    dataLines = lines;
  }

  // First pass: parse all rows
  const parsed = dataLines.map((line, idx) => {
    const parts = line.split(delimiter).map(p => p.trim());
    const get = (key) => cols[key] >= 0 ? (parts[cols[key]] || '') : '';
    const getNum = (key) => {
      const v = get(key);
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };

    const byeRaw = getNum('bye');
    return {
      id: `r-${Date.now()}-${idx}`,
      player: get('player'),
      team: get('team'),
      pos: get('pos').toUpperCase(),
      overallRank: getNum('overallRank') || (idx + 1),
      posRank: getNum('posRank'),
      // Treat 0 or missing as null (unknown bye)
      bye: byeRaw && byeRaw > 0 ? byeRaw : null,
      tier: getNum('tier'),
      notes: get('notes'),
    };
  }).filter(r => r.player);

  // Second pass: auto-compute Position Rank for any player missing one
  // Group by position, sort by overall rank, assign sequential pos rank
  const byPosition = {};
  parsed.forEach(p => {
    if (!byPosition[p.pos]) byPosition[p.pos] = [];
    byPosition[p.pos].push(p);
  });

  Object.values(byPosition).forEach(group => {
    group.sort((a, b) => (a.overallRank || 999) - (b.overallRank || 999));
    group.forEach((p, idx) => {
      if (p.posRank == null) p.posRank = idx + 1;
    });
  });

  return parsed;
};

const parseAdp = (text, targetSlot = 'adp1') => {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return {};

  const firstLine = lines[0];
  const hasTab = firstLine.includes('\t');
  const delimiter = hasTab ? '\t' : ',';

  // Detect column positions from header
  const norm = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const headerCells = firstLine.split(delimiter);
  const cols = { player: -1, pos: -1, team: -1, adp: -1, adp1: -1, adp2: -1, adp3: -1 };

  headerCells.forEach((cell, idx) => {
    const c = norm(cell);
    if (cols.player === -1 && (c === 'player' || c === 'name' || c === 'playername')) cols.player = idx;
    else if (cols.pos === -1 && (c === 'position' || c === 'pos')) cols.pos = idx;
    else if (cols.team === -1 && (c === 'team' || c === 'tm' || c === 'nflteam')) cols.team = idx;
    else if (cols.adp1 === -1 && (c === 'adp1' || c === 'adpone')) cols.adp1 = idx;
    else if (cols.adp2 === -1 && (c === 'adp2' || c === 'adptwo')) cols.adp2 = idx;
    else if (cols.adp3 === -1 && (c === 'adp3' || c === 'adpthree')) cols.adp3 = idx;
    // Common ADP source names (single-source paste)
    else if (cols.adp === -1 && ['adp', 'espn', 'sleeper', 'underdog', 'yahoo', 'cbs', 'nfl', 'fantasypros', 'rank', 'avg', 'average'].some(k => c === k || c.includes(k))) {
      cols.adp = idx;
    }
  });

  // Header detected if we found at least a player column
  const hasHeader = cols.player >= 0;

  let dataLines;
  if (hasHeader) {
    dataLines = lines.slice(1);
  } else {
    // Fallback: assume Player, Position, ADP_1, ADP_2, ADP_3
    cols.player = 0;
    cols.pos = 1;
    cols.adp1 = 2;
    cols.adp2 = 3;
    cols.adp3 = 4;
    dataLines = lines;
  }

  // Helper to extract just the leading number (e.g. "2.00 (0.20)" -> 2.00, "5.10" -> 5.10)
  const extractNumber = (val) => {
    if (!val) return null;
    const match = val.toString().match(/-?\d+\.?\d*/);
    return match ? parseFloat(match[0]) : null;
  };

  const map = {};
  dataLines.forEach(line => {
    const parts = line.split(delimiter).map(p => p.trim());
    const player = parts[cols.player];
    if (!player) return;

    // Initialize/preserve existing values
    const existing = map[player.toLowerCase()] || { adp1: null, adp2: null, adp3: null };

    // If we have explicit ADP_1/2/3 columns, use those
    if (cols.adp1 >= 0 || cols.adp2 >= 0 || cols.adp3 >= 0) {
      if (cols.adp1 >= 0) existing.adp1 = extractNumber(parts[cols.adp1]) ?? existing.adp1;
      if (cols.adp2 >= 0) existing.adp2 = extractNumber(parts[cols.adp2]) ?? existing.adp2;
      if (cols.adp3 >= 0) existing.adp3 = extractNumber(parts[cols.adp3]) ?? existing.adp3;
    } else if (cols.adp >= 0) {
      // Single ADP column — load into the specified target slot
      existing[targetSlot] = extractNumber(parts[cols.adp]) ?? existing[targetSlot];
    } else {
      // No detected ADP column — try last numeric column
      for (let i = parts.length - 1; i >= 0; i--) {
        const num = extractNumber(parts[i]);
        if (num != null && num > 0 && num < 1000) {
          existing[targetSlot] = num;
          break;
        }
      }
    }

    map[player.toLowerCase()] = existing;
  });
  return map;
};

// ==================== POSITION COLORS ====================
const POS_COLORS = {
  QB: { bg: 'bg-rose-500/15', text: 'text-rose-300', border: 'border-rose-500/40', solid: 'bg-rose-500' },
  RB: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/40', solid: 'bg-emerald-500' },
  WR: { bg: 'bg-sky-500/15', text: 'text-sky-300', border: 'border-sky-500/40', solid: 'bg-sky-500' },
  TE: { bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-amber-500/40', solid: 'bg-amber-500' },
  K: { bg: 'bg-violet-500/15', text: 'text-violet-300', border: 'border-violet-500/40', solid: 'bg-violet-500' },
  DST: { bg: 'bg-stone-500/15', text: 'text-stone-300', border: 'border-stone-500/40', solid: 'bg-stone-500' },
  FLEX: { bg: 'bg-cyan-500/15', text: 'text-cyan-300', border: 'border-cyan-500/40', solid: 'bg-cyan-500' },
};

const PosBadge = ({ pos, size = 'md' }) => {
  const c = POS_COLORS[pos] || POS_COLORS.QB;
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-flex items-center font-mono font-bold tracking-wide rounded ${sizeClass} ${c.bg} ${c.text} border ${c.border}`}>
      {pos}
    </span>
  );
};

// ==================== MAIN APP ====================
export default function App() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  // rankings is now { rank1: [...], rank2: [...], rank3: [...] }
  const [rankingsSources, setRankingsSources] = useState({ rank1: [], rank2: [], rank3: [] });
  const [adp, setAdp] = useState({});
  const [targets, setTargets] = useState([]);
  const [draft, setDraft] = useState({}); // { pickNum: playerName }
  const [ui, setUi] = useState({
    activeView: 'dashboard', // dashboard | settings | rankings | adp | targets | draftboard
    showHelp: false,
  });

  // Load all from storage on mount
  useEffect(() => {
    (async () => {
      const [s, r, a, t, d, u] = await Promise.all([
        loadStorage(KEYS.settings, DEFAULT_SETTINGS),
        loadStorage(KEYS.rankings, { rank1: [], rank2: [], rank3: [] }),
        loadStorage(KEYS.adp, {}),
        loadStorage(KEYS.targets, []),
        loadStorage(KEYS.draft, {}),
        loadStorage(KEYS.ui, { activeView: 'dashboard', showHelp: false }),
      ]);
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      // Migrate old format: if r is an array (old single-list format), move it to rank1
      if (Array.isArray(r)) {
        setRankingsSources({ rank1: r, rank2: [], rank3: [] });
      } else {
        setRankingsSources({ rank1: r.rank1 || [], rank2: r.rank2 || [], rank3: r.rank3 || [] });
      }
      setAdp(a);
      setTargets(t);
      setDraft(d);
      setUi(u);
      setLoading(false);
    })();
  }, []);

  // Auto-save on change (debounced)
  useEffect(() => { if (!loading) saveStorage(KEYS.settings, settings); }, [settings, loading]);
  useEffect(() => { if (!loading) saveStorage(KEYS.rankings, rankingsSources); }, [rankingsSources, loading]);
  useEffect(() => { if (!loading) saveStorage(KEYS.adp, adp); }, [adp, loading]);
  useEffect(() => { if (!loading) saveStorage(KEYS.targets, targets); }, [targets, loading]);
  useEffect(() => { if (!loading) saveStorage(KEYS.draft, draft); }, [draft, loading]);
  useEffect(() => { if (!loading) saveStorage(KEYS.ui, ui); }, [ui, loading]);

  // ==================== AGGREGATE RANKINGS ====================
  // Build a 4th rankings list from the average of all loaded sources.
  // Uses name matching across sources.
  const aggregateRankings = useMemo(() => {
    const sources = ['rank1', 'rank2', 'rank3'].filter(k => rankingsSources[k]?.length > 0);
    if (sources.length === 0) return [];

    // Build a map: normalized name → array of { source, rank, player object }
    // We anchor on the first source with the most data, then match others into it.
    const sourceData = sources.map(k => rankingsSources[k]);
    const totalPlayers = sourceData.reduce((sum, s) => sum + s.length, 0);

    // Collect all unique players by walking each source and matching to a master list
    const masterList = []; // { player, team, pos, ranksBySource: { rank1: x, rank2: y, rank3: z }, sourcesFound: [...] }
    const playerByNormName = {}; // normalized name → masterList entry

    sources.forEach(sourceKey => {
      const list = rankingsSources[sourceKey];
      list.forEach(p => {
        if (!p.player) return;
        const norm = normalizeName(p.player);
        // Try exact normalized match first
        let entry = playerByNormName[norm];
        // Try fuzzy match against existing entries (same position)
        if (!entry) {
          const match = findBestNameMatch(p.player, masterList, p.pos);
          if (match) {
            entry = match.match;
          }
        }
        if (!entry) {
          entry = {
            player: p.player,
            team: p.team,
            pos: p.pos,
            bye: p.bye,
            ranksBySource: {},
            sourcesFound: [],
            // Track all alias names seen across sources
            aliases: [p.player],
          };
          masterList.push(entry);
          playerByNormName[norm] = entry;
        } else {
          // Fill in missing fields if other source has them
          if (!entry.team && p.team) entry.team = p.team;
          if (!entry.bye && p.bye) entry.bye = p.bye;
          if (!entry.aliases.includes(p.player)) entry.aliases.push(p.player);
        }
        entry.ranksBySource[sourceKey] = p.overallRank;
        if (!entry.sourcesFound.includes(sourceKey)) entry.sourcesFound.push(sourceKey);
      });
    });

    // Compute aggregate rank for each player as the average of available source ranks
    // Players found in fewer sources get a penalty: missing source = ranked at (sourceLength + 50)
    masterList.forEach(entry => {
      const ranks = [];
      sources.forEach(sk => {
        if (entry.ranksBySource[sk] != null) {
          ranks.push(entry.ranksBySource[sk]);
        } else {
          // Penalty for missing: assume they would be ranked just past the end of that source
          const sourceLength = rankingsSources[sk].length;
          ranks.push(sourceLength + 50);
        }
      });
      entry.aggregateScore = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    });

    // Sort by aggregate score (ascending = best)
    masterList.sort((a, b) => a.aggregateScore - b.aggregateScore);

    // Assign overall ranks and position ranks
    const posCounters = {};
    return masterList.map((entry, idx) => {
      const pos = entry.pos;
      posCounters[pos] = (posCounters[pos] || 0) + 1;
      return {
        id: `agg-${idx}`,
        player: entry.player,
        team: entry.team,
        pos: entry.pos,
        overallRank: idx + 1,
        posRank: posCounters[pos],
        bye: entry.bye,
        tier: null, // tiers don't aggregate well
        notes: `In ${entry.sourcesFound.length}/${sources.length} sources`,
        sourcesFound: entry.sourcesFound,
        aliases: entry.aliases,
      };
    });
  }, [rankingsSources]);

  // The active ranking source for dashboard calculations
  const rankings = useMemo(() => {
    if (settings.activeRankings === 'aggregate') return aggregateRankings;
    return rankingsSources[settings.activeRankings] || [];
  }, [settings.activeRankings, rankingsSources, aggregateRankings]);

  // ==================== COMPUTED STATE ====================
  const draftedSet = useMemo(() => {
    const set = new Set();
    Object.values(draft).forEach(p => p && set.add(p.toLowerCase()));
    return set;
  }, [draft]);

  const playerToPick = useMemo(() => {
    const m = {};
    Object.entries(draft).forEach(([pickNum, player]) => {
      if (player) m[player.toLowerCase()] = parseInt(pickNum);
    });
    return m;
  }, [draft]);

  const currentPick = useMemo(() => {
    const filledPicks = Object.entries(draft)
      .filter(([_, v]) => v)
      .map(([k]) => parseInt(k));
    if (filledPicks.length === 0) return 1;
    // Find first empty pick starting from 1
    for (let p = 1; p <= settings.numTeams * settings.numRounds; p++) {
      if (!draft[p]) return p;
    }
    return settings.numTeams * settings.numRounds;
  }, [draft, settings]);

  const currentRound = Math.ceil(currentPick / settings.numTeams);
  const currentTeam = computeTeamForPick(currentPick, settings.numTeams);
  const isMyTurn = currentTeam === settings.myPick;
  const myNextPick = useMemo(() =>
    computeMyNextPick(currentPick, settings.myPick, settings.numTeams, settings.numRounds, draft),
    [currentPick, settings, draft]
  );
  const picksUntilMyTurn = myNextPick ? myNextPick - currentPick : null;

  // My drafted players (in pick order)
  const myDrafted = useMemo(() => {
    const list = [];
    for (let p = 1; p <= settings.numTeams * settings.numRounds; p++) {
      if (draft[p] && computeTeamForPick(p, settings.numTeams) === settings.myPick) {
        const playerData = rankings.find(r => r.player.toLowerCase() === draft[p].toLowerCase());
        list.push({
          pick: p,
          player: draft[p],
          pos: playerData?.pos || '',
          team: playerData?.team || '',
          bye: playerData?.bye || null,
          tier: playerData?.tier || null,
        });
      }
    }
    return list;
  }, [draft, settings, rankings]);

  // Position counts
  const posCounts = useMemo(() => {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    myDrafted.forEach(p => { if (counts[p.pos] !== undefined) counts[p.pos]++; });
    return counts;
  }, [myDrafted]);

  // Roster need bumps (per position)
  const rosterNeedBump = useMemo(() => {
    const bumps = {};
    ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].forEach(pos => {
      const required = settings.roster[pos] || 0;
      const have = posCounts[pos] || 0;
      let bump = 0;
      if (have === 0 && required > 0) bump = settings.weights.rosterNeed;
      else if (have < required) bump = settings.weights.rosterNeed * 0.5;

      // Don't bump K/DST until late
      if ((pos === 'K' || pos === 'DST') && currentPick < settings.numTeams * 13) bump = 0;
      bumps[pos] = bump;
    });
    return bumps;
  }, [posCounts, settings, currentPick]);

  // Position run momentum (last 10 picks)
  const positionRuns = useMemo(() => {
    const runs = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
    const last10 = { ...runs };
    const last5 = { ...runs };

    for (let p = Math.max(1, currentPick - 10); p < currentPick; p++) {
      const player = draft[p];
      if (!player) continue;
      const data = rankings.find(r => r.player.toLowerCase() === player.toLowerCase());
      if (data?.pos && runs[data.pos] !== undefined) {
        last10[data.pos]++;
        if (p >= currentPick - 5) last5[data.pos]++;
      }
    }

    const totals = { ...runs };
    Object.values(draft).forEach(player => {
      if (!player) return;
      const data = rankings.find(r => r.player.toLowerCase() === player.toLowerCase());
      if (data?.pos && totals[data.pos] !== undefined) totals[data.pos]++;
    });

    return { last5, last10, totals };
  }, [draft, currentPick, rankings]);

  // Scarcity bumps
  const scarcityBump = useMemo(() => {
    const bumps = {};
    ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].forEach(pos => {
      const last5 = positionRuns.last5[pos] || 0;
      const last10 = positionRuns.last10[pos] || 0;
      let bump = 0;
      if (last5 >= 3 || last10 >= 4) bump = settings.weights.scarcity;
      else if (last5 >= 2 || last10 >= 3) bump = settings.weights.scarcity * 0.5;
      bumps[pos] = bump;
    });
    return bumps;
  }, [positionRuns, settings]);

  // Available players with computed dynamic rank
  const availablePlayers = useMemo(() => {
    return rankings
      .filter(r => !draftedSet.has(r.player.toLowerCase()))
      .map(r => {
        const adpData = adp[r.player.toLowerCase()] || {};
        const playerAdp = adpData[settings.activeAdp];
        // valueVsPick: positive = good value (player available later than ADP suggests),
        // negative = reach (drafting earlier than ADP suggests)
        // Example: ADP 18.3, currentPick 6 -> 6 - 18.3 = -12.3 (reaching by 12 picks)
        // Example: ADP 5, currentPick 20 -> 20 - 5 = +15 (steal — fell 15 picks past ADP)
        const valueVsPick = playerAdp != null ? currentPick - playerAdp : null;

        // valueVsMyRank: positive = ADP says they're cheaper than I rank them (market undervalues)
        // negative = ADP says they go earlier than I rank them (market overvalues)
        // Example: My Rank 5, ADP 18 -> 18 - 5 = +13 (market undervalues — go get them)
        // Example: My Rank 20, ADP 5 -> 5 - 20 = -15 (market overdrafts — fade)
        const valueVsMyRank = (playerAdp != null && r.overallRank != null) ? playerAdp - r.overallRank : null;

        const dynRank = r.overallRank - (rosterNeedBump[r.pos] || 0) - (scarcityBump[r.pos] || 0);

        let flag = null;
        if (valueVsPick != null && playerAdp != null) {
          if (valueVsPick >= settings.thresholds.steal) flag = 'STEAL';
          else if (valueVsPick >= settings.thresholds.value) flag = 'VALUE';
          else if (valueVsPick <= -settings.thresholds.reach) flag = 'REACH';
          else flag = 'FAIR';
        }

        // Personal flag from my-rank perspective
        let myFlag = null;
        if (valueVsMyRank != null) {
          if (valueVsMyRank >= settings.thresholds.steal) myFlag = 'STEAL';
          else if (valueVsMyRank >= settings.thresholds.value) myFlag = 'VALUE';
          else if (valueVsMyRank <= -settings.thresholds.reach) myFlag = 'REACH';
          else myFlag = 'FAIR';
        }

        let snipeRisk = null;
        if (myNextPick && playerAdp != null) {
          if (playerAdp < myNextPick) snipeRisk = 'GONE';
          else if (playerAdp <= myNextPick + 3) snipeRisk = 'TIGHT';
          else snipeRisk = 'SAFE';
        }

        const isTarget = targets.some(t => t.player.toLowerCase() === r.player.toLowerCase());
        const targetData = targets.find(t => t.player.toLowerCase() === r.player.toLowerCase());

        return {
          ...r,
          adp: playerAdp,
          valueVsPick,
          valueVsMyRank,
          dynRank,
          flag,
          myFlag,
          snipeRisk,
          isTarget,
          targetPriority: targetData?.priority || null,
        };
      })
      .sort((a, b) => a.dynRank - b.dynRank);
  }, [rankings, draftedSet, adp, settings, currentPick, rosterNeedBump, scarcityBump, myNextPick, targets]);

  // Tier breakdown (count of available players per tier per position)
  const tierBreakdown = useMemo(() => {
    const breakdown = {};
    ['QB', 'RB', 'WR', 'TE'].forEach(pos => {
      breakdown[pos] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, '6+': 0 };
    });
    availablePlayers.forEach(p => {
      if (!breakdown[p.pos] || !p.tier) return;
      const tierKey = p.tier >= 6 ? '6+' : p.tier;
      breakdown[p.pos][tierKey]++;
    });
    return breakdown;
  }, [availablePlayers]);

  // Opponent needs (per team)
  const opponentNeeds = useMemo(() => {
    const teams = [];
    for (let t = 1; t <= settings.numTeams; t++) {
      const teamPicks = [];
      for (let p = 1; p < currentPick; p++) {
        if (draft[p] && computeTeamForPick(p, settings.numTeams) === t) {
          const data = rankings.find(r => r.player.toLowerCase() === draft[p].toLowerCase());
          teamPicks.push({ player: draft[p], pos: data?.pos || '' });
        }
      }
      const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
      teamPicks.forEach(tp => { if (counts[tp.pos] !== undefined) counts[tp.pos]++; });

      // Compute likely next position
      let likely = 'BPA';
      if (counts.RB < settings.roster.RB) likely = 'RB';
      else if (counts.WR < settings.roster.WR) likely = 'WR';
      else if (counts.QB < settings.roster.QB) likely = 'QB';
      else if (counts.TE < settings.roster.TE) likely = 'TE';
      else if (counts.RB + counts.WR + counts.TE < settings.roster.RB + settings.roster.WR + settings.roster.TE + settings.roster.FLEX) likely = 'FLEX';
      else if (counts.K < settings.roster.K) likely = 'K';
      else if (counts.DST < settings.roster.DST) likely = 'DST';

      teams.push({
        teamNum: t,
        isMe: t === settings.myPick,
        isOnClock: t === currentTeam,
        picks: teamPicks.length,
        counts,
        likely,
      });
    }
    return teams;
  }, [draft, currentPick, settings, rankings, currentTeam]);

  // Recommended picks (top EV)
  const recommendedPicks = useMemo(() => {
    return availablePlayers.slice(0, 8).map(p => {
      const reasons = [];
      if (p.isTarget) reasons.push('Target');
      if (p.flag === 'STEAL') reasons.push('Big value vs ADP');
      else if (p.flag === 'VALUE') reasons.push('Value vs ADP');
      if (rosterNeedBump[p.pos] > 0) reasons.push(`${p.pos} need`);
      if (scarcityBump[p.pos] > 0) reasons.push(`${p.pos} run`);

      let score = 0;
      if (p.valueVsPick != null) score += p.valueVsPick;
      if (p.isTarget) score += 10;
      score += (rosterNeedBump[p.pos] || 0) * 5;
      score += (scarcityBump[p.pos] || 0) * 3;

      return { ...p, reasons, score };
    });
  }, [availablePlayers, rosterNeedBump, scarcityBump]);

  // Bye conflicts
  const byeConflicts = useMemo(() => {
    const byByeWeek = {};
    myDrafted.forEach(p => {
      if (!p.bye) return;
      if (!byByeWeek[p.bye]) byByeWeek[p.bye] = [];
      byByeWeek[p.bye].push(p);
    });
    return Object.entries(byByeWeek)
      .filter(([_, players]) => players.length >= 2)
      .map(([week, players]) => ({ week: parseInt(week), players }));
  }, [myDrafted]);

  // ==================== ACTIONS ====================
  const handleDraftPlayer = (pickNum, playerName) => {
    setDraft(d => ({ ...d, [pickNum]: playerName }));
  };

  const handleUndraftPlayer = (pickNum) => {
    setDraft(d => {
      const next = { ...d };
      delete next[pickNum];
      return next;
    });
  };

  const handleResetDraft = () => {
    if (window.confirm('Reset the entire draft? This will clear all picks but keep rankings, ADP, and targets.')) {
      setDraft({});
    }
  };

  const handleClearAll = () => {
    if (window.confirm('Clear EVERYTHING — settings, rankings, ADP, targets, and draft? This cannot be undone.')) {
      setSettings(DEFAULT_SETTINGS);
      setRankingsSources({ rank1: [], rank2: [], rank3: [] });
      setAdp({});
      setTargets([]);
      setDraft({});
    }
  };

  // ==================== RENDER ====================
  if (loading) {
    return (
      <div className="min-h-screen bg-stone-950 flex items-center justify-center">
        <div className="text-stone-400 font-mono text-sm">LOADING DRAFT BOARD...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100">
      {/* Custom font import */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap');
        body { font-family: 'Inter', system-ui, sans-serif; }
        .font-display { font-family: 'Bebas Neue', sans-serif; letter-spacing: 0.02em; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 20px rgba(34, 211, 238, 0.4), 0 0 40px rgba(34, 211, 238, 0.2); }
          50% { box-shadow: 0 0 30px rgba(34, 211, 238, 0.7), 0 0 60px rgba(34, 211, 238, 0.4); }
        }
        .pulse-glow { animation: pulse-glow 2s ease-in-out infinite; }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .shimmer {
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
          background-size: 200% 100%;
          animation: shimmer 3s linear infinite;
        }
      `}</style>

      {/* Subtle ambient background — no grid lines */}
      <div className="fixed inset-0 pointer-events-none"
           style={{
             background: 'radial-gradient(ellipse at top, rgba(34, 211, 238, 0.04) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(245, 158, 11, 0.03) 0%, transparent 50%)',
           }} />

      {/* TOP NAV BAR */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-stone-950/80 border-b border-stone-800">
        <div className="max-w-[1800px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-md flex items-center justify-center">
                <Hexagon className="w-6 h-6 text-stone-950" strokeWidth={2.5} />
              </div>
            </div>
            <div>
              <div className="font-display text-2xl leading-none text-white">DRAFT.OPS</div>
              <div className="font-mono text-[10px] text-stone-500 uppercase tracking-widest">Live Fantasy Draft Board</div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {[
              { id: 'dashboard', icon: Activity, label: 'Live' },
              { id: 'rankings', icon: BarChart3, label: 'Rankings' },
              { id: 'adp', icon: TrendingUp, label: 'ADP' },
              { id: 'targets', icon: Target, label: 'Targets' },
              { id: 'draftboard', icon: Users, label: 'Board' },
              { id: 'settings', icon: Settings, label: 'Settings' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setUi(u => ({ ...u, activeView: tab.id }))}
                className={`px-3 py-2 rounded-md text-xs font-mono uppercase tracking-wider flex items-center gap-1.5 transition-all
                  ${ui.activeView === tab.id
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900 border border-transparent'}`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-6 py-6">
        {ui.activeView === 'dashboard' && (
          <DashboardView
            settings={settings}
            setSettings={setSettings}
            rankings={rankings}
            rankingsSources={rankingsSources}
            aggregateRankings={aggregateRankings}
            currentPick={currentPick}
            currentRound={currentRound}
            currentTeam={currentTeam}
            isMyTurn={isMyTurn}
            myNextPick={myNextPick}
            picksUntilMyTurn={picksUntilMyTurn}
            myDrafted={myDrafted}
            posCounts={posCounts}
            availablePlayers={availablePlayers}
            tierBreakdown={tierBreakdown}
            opponentNeeds={opponentNeeds}
            recommendedPicks={recommendedPicks}
            byeConflicts={byeConflicts}
            positionRuns={positionRuns}
            targets={targets}
            draftedSet={draftedSet}
            playerToPick={playerToPick}
            onDraft={handleDraftPlayer}
            onUndraft={handleUndraftPlayer}
            adp={adp}
          />
        )}

        {ui.activeView === 'rankings' && (
          <RankingsView
            rankingsSources={rankingsSources}
            setRankingsSources={setRankingsSources}
            aggregateRankings={aggregateRankings}
            settings={settings}
            setSettings={setSettings}
          />
        )}

        {ui.activeView === 'adp' && (
          <AdpView adp={adp} setAdp={setAdp} settings={settings} setSettings={setSettings} rankings={rankings} />
        )}

        {ui.activeView === 'targets' && (
          <TargetsView targets={targets} setTargets={setTargets} rankings={rankings} draftedSet={draftedSet} />
        )}

        {ui.activeView === 'draftboard' && (
          <DraftBoardView
            settings={settings}
            draft={draft}
            rankings={rankings}
            onDraft={handleDraftPlayer}
            onUndraft={handleUndraftPlayer}
            onReset={handleResetDraft}
            currentPick={currentPick}
          />
        )}

        {ui.activeView === 'settings' && (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            onClearAll={handleClearAll}
            onResetDraft={handleResetDraft}
          />
        )}
      </main>
    </div>
  );
}

// ==================== DASHBOARD VIEW ====================
function DashboardView({
  settings, setSettings, rankings, rankingsSources, aggregateRankings,
  currentPick, currentRound, currentTeam, isMyTurn,
  myNextPick, picksUntilMyTurn, myDrafted, posCounts, availablePlayers,
  tierBreakdown, opponentNeeds, recommendedPicks, byeConflicts,
  positionRuns, targets, draftedSet, playerToPick, onDraft, onUndraft, adp
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [posFilter, setPosFilter] = useState('ALL'); // ALL | QB | RB | WR | TE | K | DST | FLEX
  const [sortKey, setSortKey] = useState('dynRank'); // dynRank | overallRank | adp | tier | valueVsPick | valueVsMyRank | player | pos
  const [sortDir, setSortDir] = useState('asc'); // asc | desc

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // Sensible defaults: ranks/ADP ascending (lower=better), values descending (higher=better)
      setSortDir(['valueVsPick', 'valueVsMyRank'].includes(key) ? 'desc' : 'asc');
    }
  };

  const filteredAvailable = useMemo(() => {
    let list = availablePlayers;

    // Position filter
    if (posFilter !== 'ALL') {
      if (posFilter === 'FLEX') {
        list = list.filter(p => ['RB', 'WR', 'TE'].includes(p.pos));
      } else {
        list = list.filter(p => p.pos === posFilter);
      }
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p =>
        p.player.toLowerCase().includes(q) ||
        p.pos.toLowerCase().includes(q) ||
        (p.team || '').toLowerCase().includes(q)
      );
    }

    // Sort
    const sorted = [...list].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      // Treat null/undefined as worst
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return sorted;
  }, [availablePlayers, searchQuery, posFilter, sortKey, sortDir]);

  // Active source label + counts for the dropdown
  const sourceOptions = useMemo(() => {
    const opts = [];
    ['rank1', 'rank2', 'rank3'].forEach(key => {
      const count = rankingsSources[key]?.length || 0;
      opts.push({
        key,
        label: settings.rankingLabels?.[key] || key,
        count,
        disabled: count === 0,
      });
    });
    const aggCount = aggregateRankings.length;
    const sourcesLoaded = ['rank1', 'rank2', 'rank3'].filter(k => rankingsSources[k]?.length > 0).length;
    opts.push({
      key: 'aggregate',
      label: settings.rankingLabels?.aggregate || 'Aggregate',
      count: aggCount,
      disabled: sourcesLoaded < 2,
      sublabel: sourcesLoaded < 2 ? 'Need 2+ sources' : `Avg of ${sourcesLoaded} sources`,
    });
    return opts;
  }, [rankingsSources, aggregateRankings, settings.rankingLabels]);

  if (rankings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="w-20 h-20 rounded-2xl bg-stone-900 border border-stone-800 flex items-center justify-center mb-6">
          <BarChart3 className="w-10 h-10 text-stone-600" />
        </div>
        <h2 className="font-display text-3xl mb-2">No Rankings Loaded</h2>
        <p className="text-stone-500 max-w-md mb-6">
          Add your rankings in the Rankings tab to start. Your dashboard comes alive once you have player data.
        </p>
        <div className="font-mono text-xs text-stone-600">→ Click <span className="text-cyan-400">RANKINGS</span> in the top nav to begin</div>
      </div>
    );
  }

  const onClockText = isMyTurn ? "YOU'RE ON THE CLOCK" : `Team ${currentTeam} on the clock`;

  return (
    <div className="space-y-4">
      {/* HERO STATUS BAR */}
      <div className={`relative overflow-hidden rounded-2xl border ${isMyTurn ? 'border-cyan-500/50 pulse-glow' : 'border-stone-800'} bg-gradient-to-br from-stone-900 to-stone-950`}>
        <div className="absolute inset-0 shimmer pointer-events-none" />
        <div className="relative grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {/* Current Pick */}
          <div className="p-5 border-b border-r border-stone-800 md:border-b-0 lg:border-b-0">
            <div className="font-mono text-[10px] text-stone-500 uppercase tracking-widest mb-2">Current Pick</div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-5xl text-white">#{currentPick}</span>
              <span className="font-mono text-xs text-stone-500">/ {settings.numTeams * settings.numRounds}</span>
            </div>
            <div className="font-mono text-xs text-stone-400 mt-1">Round {currentRound}.{((currentPick - 1) % settings.numTeams) + 1}</div>
          </div>

          {/* On Clock */}
          <div className={`p-5 border-b border-r border-stone-800 md:border-b-0 lg:border-b-0 ${isMyTurn ? 'bg-cyan-500/10' : ''}`}>
            <div className={`font-mono text-[10px] uppercase tracking-widest mb-2 ${isMyTurn ? 'text-cyan-400' : 'text-stone-500'}`}>On The Clock</div>
            <div className="flex items-baseline gap-2">
              <span className={`font-display text-5xl ${isMyTurn ? 'text-cyan-300' : 'text-white'}`}>
                {isMyTurn ? 'YOU' : `T${currentTeam}`}
              </span>
            </div>
            <div className={`font-mono text-xs mt-1 ${isMyTurn ? 'text-cyan-400 font-bold' : 'text-stone-400'}`}>
              {onClockText}
            </div>
          </div>

          {/* My Next Pick */}
          <div className="p-5 border-b border-r border-stone-800 md:border-b-0 md:border-r-0 lg:border-r lg:border-b-0">
            <div className="font-mono text-[10px] text-stone-500 uppercase tracking-widest mb-2">My Next Pick</div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-5xl text-amber-300">
                {myNextPick ? `#${myNextPick}` : '—'}
              </span>
            </div>
            <div className="font-mono text-xs text-stone-400 mt-1">
              {myNextPick ? `R${Math.ceil(myNextPick / settings.numTeams)}.${((myNextPick - 1) % settings.numTeams) + 1}` : 'Draft complete'}
            </div>
          </div>

          {/* Picks Until */}
          <div className="p-5 border-r border-stone-800">
            <div className="font-mono text-[10px] text-stone-500 uppercase tracking-widest mb-2">Picks Until Mine</div>
            <div className="flex items-baseline gap-2">
              <span className={`font-display text-5xl ${picksUntilMyTurn === 0 ? 'text-cyan-300' : picksUntilMyTurn != null && picksUntilMyTurn <= 2 ? 'text-amber-300' : 'text-white'}`}>
                {picksUntilMyTurn != null ? picksUntilMyTurn : '—'}
              </span>
            </div>
            <div className="font-mono text-xs text-stone-400 mt-1">
              {picksUntilMyTurn === 0 ? 'GO!' : 'till you pick'}
            </div>
          </div>

          {/* Roster Filled */}
          <div className="p-5">
            <div className="font-mono text-[10px] text-stone-500 uppercase tracking-widest mb-2">My Roster</div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-5xl text-white">{myDrafted.length}</span>
              <span className="font-mono text-xs text-stone-500">/ {Object.values(settings.roster).reduce((a, b) => a + b, 0)}</span>
            </div>
            <div className="font-mono text-xs text-stone-400 mt-1">{settings.leagueName}</div>
          </div>
        </div>
      </div>

      {/* QUICK PICK COMMAND BAR */}
      <QuickPickBar
        rankings={rankings}
        draftedSet={draftedSet}
        playerToPick={playerToPick}
        currentPick={currentPick}
        settings={settings}
        adp={adp}
        onDraft={onDraft}
      />

      {/* MAIN GRID */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* LEFT: Top Available */}
        <div className="xl:col-span-8 space-y-4">
          <Panel
            title="Top Available"
            icon={<Crown className="w-4 h-4" />}
            accent="cyan"
            actions={
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {/* Rankings source dropdown */}
                <RankingsSourceDropdown
                  sourceOptions={sourceOptions}
                  activeKey={settings.activeRankings}
                  onChange={(key) => setSettings(s => ({ ...s, activeRankings: key }))}
                />
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-stone-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search..."
                    className="font-mono text-xs bg-stone-900 border border-stone-700 rounded pl-7 pr-2 py-1 w-32 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <span className="font-mono text-[10px] text-stone-500 uppercase tracking-wider">
                  {filteredAvailable.length} avail
                </span>
              </div>
            }
          >
            {/* Position filter pills */}
            <div className="flex items-center gap-1 mb-3 flex-wrap">
              {['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'].map(pos => {
                const count = pos === 'ALL'
                  ? availablePlayers.length
                  : pos === 'FLEX'
                    ? availablePlayers.filter(p => ['RB', 'WR', 'TE'].includes(p.pos)).length
                    : availablePlayers.filter(p => p.pos === pos).length;
                const active = posFilter === pos;
                return (
                  <button
                    key={pos}
                    onClick={() => setPosFilter(pos)}
                    className={`px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border flex items-center gap-1.5 transition-all ${
                      active
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'bg-stone-900 text-stone-400 border-stone-800 hover:bg-stone-800'
                    }`}
                  >
                    {pos}
                    <span className={`font-bold ${active ? 'text-cyan-400' : 'text-stone-600'}`}>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-stone-500 font-mono border-b border-stone-800">
                    <SortableTh sortKey="dynRank" currentKey={sortKey} dir={sortDir} onSort={handleSort}>Dyn</SortableTh>
                    <SortableTh sortKey="overallRank" currentKey={sortKey} dir={sortDir} onSort={handleSort}>My</SortableTh>
                    <SortableTh sortKey="player" currentKey={sortKey} dir={sortDir} onSort={handleSort}>Player</SortableTh>
                    <SortableTh sortKey="pos" currentKey={sortKey} dir={sortDir} onSort={handleSort}>Pos</SortableTh>
                    <th className="text-left py-2 px-3 font-medium">Tm</th>
                    <th className="text-left py-2 px-3 font-medium">Bye</th>
                    <SortableTh sortKey="tier" currentKey={sortKey} dir={sortDir} onSort={handleSort}>Tier</SortableTh>
                    <SortableTh sortKey="adp" currentKey={sortKey} dir={sortDir} onSort={handleSort}>ADP</SortableTh>
                    <SortableTh sortKey="valueVsPick" currentKey={sortKey} dir={sortDir} onSort={handleSort} title="ADP vs current pick">Pick Δ</SortableTh>
                    <SortableTh sortKey="valueVsMyRank" currentKey={sortKey} dir={sortDir} onSort={handleSort} title="ADP vs your ranking">My Δ</SortableTh>
                    <th className="text-left py-2 px-3 font-medium">Flag</th>
                    <th className="text-left py-2 px-3 font-medium">Snipe</th>
                    <th className="text-right py-2 px-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {filteredAvailable.slice(0, 50).map((p, i) => (
                    <tr key={p.id || p.player} className={`border-b border-stone-900 hover:bg-stone-800/40 transition-colors ${p.isTarget ? 'bg-amber-500/5' : i % 2 === 0 ? 'bg-stone-900/20' : ''}`}>
                      <td className="py-2 px-3">
                        <span className={`font-bold ${p.dynRank < p.overallRank ? 'text-cyan-400' : p.dynRank > p.overallRank ? 'text-amber-400' : 'text-stone-200'}`}>
                          {Math.round(p.dynRank)}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-stone-500">{p.overallRank}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          {p.isTarget && (
                            <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                          )}
                          <span className="text-stone-100 font-semibold">{p.player}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3"><PosBadge pos={p.pos} size="sm" /></td>
                      <td className="py-2 px-3 text-stone-400">{p.team}</td>
                      <td className="py-2 px-3 text-stone-400">{p.bye || '—'}</td>
                      <td className="py-2 px-3 text-stone-400">{p.tier ? `T${p.tier}` : '—'}</td>
                      <td className="py-2 px-3 text-stone-300">{p.adp != null ? p.adp.toFixed(1) : '—'}</td>
                      <td className={`py-2 px-3 font-bold ${
                        p.valueVsPick == null ? 'text-stone-600' :
                        p.valueVsPick >= 6 ? 'text-emerald-400' :
                        p.valueVsPick <= -6 ? 'text-rose-400' : 'text-stone-400'
                      }`}>
                        {p.valueVsPick == null ? '—' : (p.valueVsPick > 0 ? '+' : '') + p.valueVsPick.toFixed(0)}
                      </td>
                      <td className={`py-2 px-3 font-bold ${
                        p.valueVsMyRank == null ? 'text-stone-600' :
                        p.valueVsMyRank >= 6 ? 'text-emerald-400' :
                        p.valueVsMyRank <= -6 ? 'text-rose-400' : 'text-stone-400'
                      }`}>
                        {p.valueVsMyRank == null ? '—' : (p.valueVsMyRank > 0 ? '+' : '') + p.valueVsMyRank.toFixed(0)}
                      </td>
                      <td className="py-2 px-3">
                        {p.flag === 'STEAL' && <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">STEAL</span>}
                        {p.flag === 'VALUE' && <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">VALUE</span>}
                        {p.flag === 'FAIR' && <span className="text-stone-500 text-[10px]">FAIR</span>}
                        {p.flag === 'REACH' && <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold">REACH</span>}
                        {!p.flag && <span className="text-stone-700">—</span>}
                      </td>
                      <td className="py-2 px-3">
                        {p.snipeRisk === 'GONE' && <span className="text-rose-400 font-bold">⚠ GONE</span>}
                        {p.snipeRisk === 'TIGHT' && <span className="text-amber-400 font-bold">! TIGHT</span>}
                        {p.snipeRisk === 'SAFE' && <span className="text-emerald-500/70">SAFE</span>}
                        {!p.snipeRisk && <span className="text-stone-700">—</span>}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => onDraft(currentPick, p.player)}
                          className="px-2 py-1 rounded bg-cyan-500/10 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-[10px] font-bold uppercase tracking-wider transition-all"
                        >
                          Draft #{currentPick}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredAvailable.length === 0 && (
                <div className="text-center py-8 text-stone-600 text-sm">No players match your filters</div>
              )}
            </div>
          </Panel>

          {/* Run Tracker + Tier Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Panel title="Position Runs" icon={<Flame className="w-4 h-4" />} accent="rose">
              <div className="space-y-2">
                {['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => {
                  const last5 = positionRuns.last5[pos] || 0;
                  const last10 = positionRuns.last10[pos] || 0;
                  const total = positionRuns.totals[pos] || 0;
                  const isHot = last5 >= 3 || last10 >= 5;
                  const isActive = !isHot && (last5 >= 2 || last10 >= 3);
                  return (
                    <div key={pos} className="flex items-center gap-3 py-1">
                      <PosBadge pos={pos} size="sm" />
                      <div className="flex-1 grid grid-cols-3 gap-1 font-mono text-xs">
                        <div className="text-stone-500">Total: <span className="text-stone-200">{total}</span></div>
                        <div className="text-stone-500">L10: <span className="text-stone-200">{last10}</span></div>
                        <div className="text-stone-500">L5: <span className="text-stone-200">{last5}</span></div>
                      </div>
                      {isHot && (
                        <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold flex items-center gap-1">
                          <Flame className="w-3 h-3" /> HOT
                        </span>
                      )}
                      {isActive && (
                        <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">ACTIVE</span>
                      )}
                      {!isHot && !isActive && <span className="text-stone-700 text-xs">—</span>}
                    </div>
                  );
                })}
              </div>
            </Panel>

            <Panel title="Tier Scarcity" icon={<BarChart3 className="w-4 h-4" />} accent="violet">
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full font-mono text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-stone-500">
                      <th className="text-left py-1 pr-2 font-medium">Pos</th>
                      {['1', '2', '3', '4', '5', '6+'].map(t => (
                        <th key={t} className="text-center py-1 px-1 font-medium">T{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {['QB', 'RB', 'WR', 'TE'].map(pos => (
                      <tr key={pos} className="border-t border-stone-900">
                        <td className="py-1.5 pr-2"><PosBadge pos={pos} size="sm" /></td>
                        {['1', '2', '3', '4', '5', '6+'].map(t => {
                          const count = tierBreakdown[pos]?.[t] || 0;
                          const color = count === 0 ? 'text-stone-700' :
                                        count <= 2 ? 'text-rose-400' :
                                        count <= 5 ? 'text-amber-400' : 'text-emerald-400';
                          return (
                            <td key={t} className={`text-center py-1.5 px-1 font-bold ${color}`}>
                              {count || '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* Opponent Needs Grid */}
          <Panel title="Opponent Needs" icon={<Users className="w-4 h-4" />} accent="amber">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-stone-500 border-b border-stone-800">
                    <th className="text-left py-2 px-2 font-medium">Team</th>
                    <th className="text-center py-2 px-2 font-medium">Picks</th>
                    {['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => (
                      <th key={pos} className="text-center py-2 px-2 font-medium">{pos}</th>
                    ))}
                    <th className="text-left py-2 px-2 font-medium">Likely Next</th>
                    <th className="text-center py-2 px-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {opponentNeeds.map(t => (
                    <tr key={t.teamNum} className={`border-b border-stone-900 ${t.isMe ? 'bg-amber-500/10' : t.isOnClock ? 'bg-cyan-500/10' : ''}`}>
                      <td className="py-2 px-2 font-bold">
                        T{t.teamNum} {t.isMe && <span className="text-amber-400">(you)</span>}
                      </td>
                      <td className="text-center py-2 px-2 text-stone-300">{t.picks}</td>
                      {['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => (
                        <td key={pos} className={`text-center py-2 px-2 ${t.counts[pos] > 0 ? 'text-stone-200' : 'text-stone-700'}`}>
                          {t.counts[pos] || '·'}
                        </td>
                      ))}
                      <td className="py-2 px-2"><PosBadge pos={t.likely === 'BPA' ? 'FLEX' : t.likely} size="sm" /></td>
                      <td className="text-center py-2 px-2">
                        {t.isOnClock && (
                          <span className="px-2 py-0.5 rounded bg-cyan-500/30 text-cyan-200 text-[10px] font-bold animate-pulse">⚡ NOW</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        {/* RIGHT: My Roster + Recommendations + Targets */}
        <div className="xl:col-span-4 space-y-4">
          {/* RECOMMENDED PICKS — show only when it's my turn or close to it */}
          {(isMyTurn || (picksUntilMyTurn != null && picksUntilMyTurn <= 3)) && recommendedPicks.length > 0 && (
            <Panel
              title={isMyTurn ? "▶ Pick Now" : "Coming Up"}
              icon={<Zap className="w-4 h-4" />}
              accent={isMyTurn ? "cyan-strong" : "cyan"}
            >
              <div className="space-y-2">
                {recommendedPicks.slice(0, 5).map((p, i) => (
                  <div key={p.player} className={`flex items-center gap-3 p-3 rounded-lg border transition-all hover:bg-stone-900 ${
                    i === 0 ? 'bg-gradient-to-r from-cyan-500/10 to-transparent border-cyan-500/30' : 'bg-stone-900/50 border-stone-800'
                  }`}>
                    <div className={`font-display text-2xl ${i === 0 ? 'text-cyan-300' : 'text-stone-500'}`}>
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {p.isTarget && <Star className="w-3 h-3 text-amber-400 fill-amber-400 flex-shrink-0" />}
                        <span className="font-semibold text-stone-100 truncate">{p.player}</span>
                        <PosBadge pos={p.pos} size="sm" />
                      </div>
                      <div className="font-mono text-[10px] text-stone-500 mt-0.5">
                        {p.reasons.length > 0 ? p.reasons.join(' • ') : `Best player available`}
                      </div>
                    </div>
                    {isMyTurn && (
                      <button
                        onClick={() => onDraft(currentPick, p.player)}
                        className="px-3 py-1.5 rounded bg-cyan-500 hover:bg-cyan-400 text-stone-950 text-[10px] font-bold uppercase tracking-wider transition-all flex-shrink-0"
                      >
                        Draft
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* MY ROSTER */}
          <Panel title="My Roster" icon={<Crown className="w-4 h-4" />} accent="amber">
            <RosterSlots
              myDrafted={myDrafted}
              settings={settings}
              onUndraft={(pick) => onUndraft(pick)}
            />
          </Panel>

          {/* POSITION COUNTS */}
          <Panel title="Roster Needs" icon={<Activity className="w-4 h-4" />} accent="emerald">
            <div className="space-y-1.5 font-mono text-xs">
              {['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => {
                const have = posCounts[pos] || 0;
                const need = settings.roster[pos] || 0;
                const status = have >= need ? 'filled' : have === 0 ? 'empty' : 'partial';
                return (
                  <div key={pos} className="flex items-center gap-3">
                    <PosBadge pos={pos} size="sm" />
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-stone-900 rounded-full overflow-hidden">
                        <div className={`h-full transition-all ${
                          status === 'filled' ? 'bg-emerald-500' :
                          status === 'partial' ? 'bg-amber-500' : 'bg-stone-700'
                        }`} style={{ width: `${Math.min(100, (have / Math.max(1, need)) * 100)}%` }} />
                      </div>
                      <span className="text-stone-300 w-10 text-right">{have}/{need}</span>
                    </div>
                    {status === 'empty' && <CircleAlert className="w-3.5 h-3.5 text-rose-400" />}
                    {status === 'filled' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    {status === 'partial' && <Clock className="w-3.5 h-3.5 text-amber-400" />}
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* BYE WEEK CONFLICTS */}
          {byeConflicts.length > 0 && (
            <Panel title="Bye Conflicts" icon={<AlertTriangle className="w-4 h-4" />} accent="rose">
              <div className="space-y-2">
                {byeConflicts.map(({ week, players }) => (
                  <div key={week} className={`p-2 rounded-lg ${players.length >= 3 ? 'bg-rose-500/10 border border-rose-500/30' : 'bg-amber-500/10 border border-amber-500/30'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-bold">Week {week}</span>
                      <span className={`font-mono text-[10px] font-bold ${players.length >= 3 ? 'text-rose-300' : 'text-amber-300'}`}>
                        {players.length} players
                      </span>
                    </div>
                    <div className="text-[11px] text-stone-400 leading-relaxed">
                      {players.map(p => p.player).join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* TARGETS WATCH */}
          {targets.length > 0 && (
            <Panel title="Targets Watch" icon={<Target className="w-4 h-4" />} accent="violet">
              <div className="space-y-1.5">
                {targets
                  .filter(t => t.player)
                  .sort((a, b) => (a.priority || 99) - (b.priority || 99))
                  .map(t => {
                    const playerData = rankings.find(r => r.player.toLowerCase() === t.player.toLowerCase());
                    const adpData = adp[t.player.toLowerCase()] || {};
                    const playerAdp = adpData[settings.activeAdp];
                    const isDrafted = draftedSet.has(t.player.toLowerCase());
                    let snipeRisk = null;
                    if (!isDrafted && myNextPick && playerAdp != null) {
                      if (playerAdp < myNextPick) snipeRisk = 'RISK';
                      else if (playerAdp <= myNextPick + 5) snipeRisk = 'TIGHT';
                      else snipeRisk = 'SAFE';
                    }
                    return (
                      <div key={t.id} className={`flex items-center gap-2 p-1.5 rounded ${isDrafted ? 'opacity-40' : ''}`}>
                        <div className={`w-5 h-5 rounded flex items-center justify-center font-mono text-[10px] font-bold flex-shrink-0 ${
                          t.priority === 1 ? 'bg-amber-500/30 text-amber-300' :
                          t.priority === 2 ? 'bg-violet-500/30 text-violet-300' :
                          'bg-stone-700/50 text-stone-400'
                        }`}>
                          {t.priority || '?'}
                        </div>
                        <span className={`flex-1 text-xs truncate ${isDrafted ? 'line-through text-stone-500' : 'text-stone-200 font-semibold'}`}>
                          {t.player}
                        </span>
                        {playerData && <PosBadge pos={playerData.pos} size="sm" />}
                        <span className="font-mono text-[10px] text-stone-500 w-10 text-right">
                          {playerAdp != null ? playerAdp.toFixed(0) : '—'}
                        </span>
                        {isDrafted ? (
                          <span className="font-mono text-[10px] text-rose-400 font-bold">GONE</span>
                        ) : snipeRisk === 'RISK' ? (
                          <span className="font-mono text-[10px] text-rose-400 font-bold">⚠</span>
                        ) : snipeRisk === 'TIGHT' ? (
                          <span className="font-mono text-[10px] text-amber-400 font-bold">!</span>
                        ) : snipeRisk === 'SAFE' ? (
                          <span className="font-mono text-[10px] text-emerald-500/70">✓</span>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== QUICK PICK BAR ====================
// Type-to-search command bar for fast pick logging during a live draft.
// Always shows the current pick. Tab/Enter selects the highlighted suggestion.
// Also lets you log a different pick # with the optional pick selector.
function QuickPickBar({ rankings, draftedSet, playerToPick, currentPick, settings, adp, onDraft }) {
  const [query, setQuery] = useState('');
  const [pickNum, setPickNum] = useState(currentPick);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [pickPickerOpen, setPickPickerOpen] = useState(false);
  const inputRef = useRef(null);
  const pickPickerRef = useRef(null);

  // Keep pick number synced with current pick when user isn't manually overriding
  useEffect(() => { setPickNum(currentPick); }, [currentPick]);

  // Reset highlight when query changes
  useEffect(() => { setHighlightIdx(0); }, [query]);

  // Close pick picker when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (pickPickerRef.current && !pickPickerRef.current.contains(e.target)) {
        setPickPickerOpen(false);
      }
    };
    if (pickPickerOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickPickerOpen]);

  // Cmd/Ctrl-K focuses the search box
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase().trim();
    // Match by player name (prefer prefix matches first)
    const scored = rankings
      .map(r => {
        const name = r.player.toLowerCase();
        let score = 0;
        if (name.startsWith(q)) score = 100;
        else if (name.includes(' ' + q)) score = 80; // word boundary match
        else if (name.includes(q)) score = 50;
        else return null;
        return { ...r, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.overallRank - b.overallRank)
      .slice(0, 8);
    return scored;
  }, [query, rankings]);

  const draftPlayer = (player) => {
    if (!player) return;
    const isAlreadyDrafted = playerToPick[player.player.toLowerCase()];
    if (isAlreadyDrafted && isAlreadyDrafted !== pickNum) {
      if (!window.confirm(`${player.player} is already drafted at pick #${isAlreadyDrafted}. Move them to pick #${pickNum}?`)) return;
    }
    onDraft(pickNum, player.player);
    setQuery('');
    setHighlightIdx(0);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && suggestions.length > 0) {
      e.preventDefault();
      draftPlayer(suggestions[highlightIdx]);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  const totalPicks = settings.numTeams * settings.numRounds;
  const teamForPick = computeTeamForPick(pickNum, settings.numTeams);
  const isMyPickNum = teamForPick === settings.myPick;

  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/50 p-3 relative">
      <div className="flex items-center gap-3">
        {/* Pick # selector */}
        <div className="relative" ref={pickPickerRef}>
          <button
            onClick={() => setPickPickerOpen(o => !o)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${
              isMyPickNum
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                : 'bg-stone-950 border-stone-700 text-stone-300 hover:border-stone-600'
            }`}
          >
            <Hexagon className="w-4 h-4" />
            <div className="text-left">
              <div className="font-mono text-[9px] text-stone-500 uppercase tracking-wider leading-none">Pick</div>
              <div className="font-mono text-sm font-bold leading-tight">
                #{pickNum} <span className="text-stone-500 font-normal">→ T{teamForPick}</span>
              </div>
            </div>
            <ChevronDown className={`w-3 h-3 text-stone-500 transition-transform ${pickPickerOpen ? 'rotate-180' : ''}`} />
          </button>
          {pickPickerOpen && (
            <div className="absolute top-full left-0 mt-1 bg-stone-900 border border-stone-700 rounded-lg shadow-2xl z-30 overflow-hidden">
              <div className="p-2 border-b border-stone-800">
                <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider mb-1">Jump to pick</div>
                <input
                  type="number"
                  min="1"
                  max={totalPicks}
                  value={pickNum}
                  onChange={(e) => setPickNum(Math.max(1, Math.min(totalPicks, parseInt(e.target.value) || 1)))}
                  className="w-32 bg-stone-950 border border-stone-700 rounded px-2 py-1 font-mono text-sm focus:outline-none focus:border-cyan-500/50"
                />
              </div>
              <button
                onClick={() => { setPickNum(currentPick); setPickPickerOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-stone-800 font-mono text-xs text-cyan-300 border-b border-stone-800"
              >
                ↺ Reset to current pick (#{currentPick})
              </button>
            </div>
          )}
        </div>

        {/* Search input */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a player name to draft them at this pick (try ⌘K)..."
            className="w-full bg-stone-950 border border-stone-700 rounded-lg pl-10 pr-20 py-2.5 text-sm focus:outline-none focus:border-cyan-500/50 placeholder:text-stone-600"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
            <kbd className="font-mono text-[9px] text-stone-500 bg-stone-900 border border-stone-700 rounded px-1.5 py-0.5">↵</kbd>
            <span className="font-mono text-[9px] text-stone-600">to draft</span>
          </div>
        </div>

        {/* Status indicator */}
        <div className={`px-3 py-2 rounded-lg font-mono text-xs ${
          isMyPickNum
            ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
            : 'bg-stone-950 text-stone-400 border border-stone-800'
        }`}>
          {isMyPickNum ? '⭐ YOUR PICK' : `Team ${teamForPick}`}
        </div>
      </div>

      {/* Suggestions dropdown */}
      {suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 mx-3 bg-stone-900 border border-stone-700 rounded-lg shadow-2xl z-20 overflow-hidden">
          {suggestions.map((s, idx) => {
            const isDrafted = draftedSet.has(s.player.toLowerCase());
            const draftedAt = playerToPick[s.player.toLowerCase()];
            const adpData = adp[s.player.toLowerCase()] || {};
            const playerAdp = adpData[settings.activeAdp];
            return (
              <button
                key={s.id}
                onMouseDown={(e) => { e.preventDefault(); draftPlayer(s); }}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                  highlightIdx === idx ? 'bg-cyan-500/15' : ''
                } ${isDrafted ? 'opacity-50' : ''}`}
              >
                <PosBadge pos={s.pos} size="sm" />
                <span className={`flex-1 font-semibold ${isDrafted ? 'line-through text-stone-500' : 'text-stone-100'}`}>
                  {s.player}
                </span>
                <span className="font-mono text-xs text-stone-500">{s.team}</span>
                <span className="font-mono text-xs text-stone-500 w-12 text-right">
                  Rk #{s.overallRank}
                </span>
                <span className="font-mono text-xs text-stone-500 w-16 text-right">
                  ADP {playerAdp != null ? playerAdp.toFixed(1) : '—'}
                </span>
                {isDrafted ? (
                  <span className="font-mono text-[10px] text-rose-400 font-bold w-16 text-right">
                    @ #{draftedAt}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-cyan-400 font-bold w-16 text-right">
                    DRAFT →
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== ROSTER SLOTS COMPONENT ====================
function RosterSlots({ myDrafted, settings, onUndraft }) {
  // Build slot list
  const slots = [];
  const pool = [...myDrafted];

  // Helper to take first player matching position
  const take = (pos) => {
    const idx = pool.findIndex(p => p.pos === pos);
    if (idx >= 0) return pool.splice(idx, 1)[0];
    return null;
  };

  // QB
  for (let i = 0; i < settings.roster.QB; i++) slots.push({ label: `QB${i + 1}`, pos: 'QB', player: take('QB') });
  // RB
  for (let i = 0; i < settings.roster.RB; i++) slots.push({ label: `RB${i + 1}`, pos: 'RB', player: take('RB') });
  // WR
  for (let i = 0; i < settings.roster.WR; i++) slots.push({ label: `WR${i + 1}`, pos: 'WR', player: take('WR') });
  // TE
  for (let i = 0; i < settings.roster.TE; i++) slots.push({ label: `TE${i + 1}`, pos: 'TE', player: take('TE') });
  // FLEX
  for (let i = 0; i < settings.roster.FLEX; i++) {
    let p = take('RB') || take('WR') || take('TE');
    slots.push({ label: 'FLEX', pos: 'FLEX', player: p });
  }
  // K, DST
  for (let i = 0; i < settings.roster.K; i++) slots.push({ label: 'K', pos: 'K', player: take('K') });
  for (let i = 0; i < settings.roster.DST; i++) slots.push({ label: 'DST', pos: 'DST', player: take('DST') });
  // Bench
  for (let i = 0; i < settings.roster.BENCH; i++) slots.push({ label: `BN${i + 1}`, pos: null, player: pool.shift() || null });

  return (
    <div className="space-y-1">
      {slots.map((slot, i) => (
        <div key={i} className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono ${
          slot.player ? 'bg-stone-900/50 border border-stone-800' : 'border border-dashed border-stone-800'
        }`}>
          <span className={`w-10 text-[10px] uppercase tracking-wider font-bold ${
            slot.player ? 'text-stone-400' : 'text-stone-600'
          }`}>
            {slot.label}
          </span>
          {slot.player ? (
            <>
              <PosBadge pos={slot.player.pos} size="sm" />
              <span className="flex-1 truncate text-stone-100 font-semibold">{slot.player.player}</span>
              <span className="text-stone-500 text-[10px]">B{slot.player.bye || '?'}</span>
              <span className="text-stone-500 text-[10px]">#{slot.player.pick}</span>
              <button
                onClick={() => onUndraft(slot.player.pick)}
                className="text-stone-600 hover:text-rose-400 transition-colors"
                title="Remove pick"
              >
                <X className="w-3 h-3" />
              </button>
            </>
          ) : (
            <span className="text-stone-600 italic">empty</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ==================== SORTABLE TH ====================
function SortableTh({ sortKey, currentKey, dir, onSort, children, align = 'left', title }) {
  const isActive = currentKey === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={title}
      className={`text-${align} py-2 px-3 font-medium cursor-pointer select-none hover:text-stone-300 transition-colors ${isActive ? 'text-cyan-300' : ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {isActive && (
          <span className="text-[8px] leading-none">{dir === 'asc' ? '▲' : '▼'}</span>
        )}
      </span>
    </th>
  );
}

// ==================== RANKINGS SOURCE DROPDOWN ====================
function RankingsSourceDropdown({ sourceOptions, activeKey, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const active = sourceOptions.find(o => o.key === activeKey) || sourceOptions[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-stone-900 hover:bg-stone-800 border border-stone-700 text-stone-200 text-xs font-mono uppercase tracking-wider transition-all"
      >
        <BarChart3 className="w-3 h-3 text-cyan-400" />
        <span>{active?.label || 'Rankings'}</span>
        <span className="text-stone-500 font-normal text-[10px]">({active?.count || 0})</span>
        <ChevronDown className={`w-3 h-3 text-stone-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-stone-900 border border-stone-700 rounded-lg shadow-2xl z-30 overflow-hidden min-w-[220px]">
          <div className="px-3 py-2 border-b border-stone-800 font-mono text-[10px] uppercase tracking-wider text-stone-500">
            Switch rankings source
          </div>
          {sourceOptions.map(opt => (
            <button
              key={opt.key}
              disabled={opt.disabled}
              onClick={() => { if (!opt.disabled) { onChange(opt.key); setOpen(false); } }}
              className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                opt.disabled ? 'opacity-40 cursor-not-allowed' :
                activeKey === opt.key ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-stone-800 text-stone-200'
              }`}
            >
              <div className="flex flex-col">
                <span className="font-mono text-xs font-bold">
                  {opt.key === 'aggregate' && '★ '}
                  {opt.label}
                </span>
                {opt.sublabel && (
                  <span className="font-mono text-[9px] text-stone-500">{opt.sublabel}</span>
                )}
              </div>
              <span className="font-mono text-[10px] text-stone-500">{opt.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== PANEL COMPONENT ====================
function Panel({ title, icon, accent = 'stone', actions, children }) {
  const accentColors = {
    cyan: 'border-cyan-500/20 from-cyan-500/5',
    'cyan-strong': 'border-cyan-500/50 from-cyan-500/10',
    rose: 'border-rose-500/20 from-rose-500/5',
    amber: 'border-amber-500/20 from-amber-500/5',
    emerald: 'border-emerald-500/20 from-emerald-500/5',
    violet: 'border-violet-500/20 from-violet-500/5',
    stone: 'border-stone-800 from-stone-900/50',
  };
  const iconColors = {
    cyan: 'text-cyan-400',
    'cyan-strong': 'text-cyan-300',
    rose: 'text-rose-400',
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    violet: 'text-violet-400',
    stone: 'text-stone-400',
  };
  return (
    <div className={`relative rounded-xl border ${accentColors[accent]} bg-gradient-to-b to-stone-950 overflow-hidden`}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800/50">
        <div className="flex items-center gap-2">
          <span className={iconColors[accent]}>{icon}</span>
          <h3 className="font-display text-sm uppercase tracking-wider text-stone-200">{title}</h3>
        </div>
        {actions}
      </div>
      <div className="p-4">
        {children}
      </div>
    </div>
  );
}

// ==================== RANKINGS VIEW ====================
function RankingsView({ rankingsSources, setRankingsSources, aggregateRankings, settings, setSettings }) {
  // Active source being viewed/edited
  const [activeSource, setActiveSource] = useState(() => {
    // Default to first source with data, or rank1
    const sources = ['rank1', 'rank2', 'rank3'];
    return sources.find(s => rankingsSources[s]?.length > 0) || 'rank1';
  });
  const [pasteText, setPasteText] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [filterPos, setFilterPos] = useState('ALL');
  const [search, setSearch] = useState('');

  const isAggregate = activeSource === 'aggregate';
  const currentList = isAggregate ? aggregateRankings : (rankingsSources[activeSource] || []);

  const setCurrentList = (updater) => {
    if (isAggregate) return; // can't edit aggregate
    setRankingsSources(s => ({
      ...s,
      [activeSource]: typeof updater === 'function' ? updater(s[activeSource] || []) : updater,
    }));
  };

  const handlePaste = () => {
    const parsed = parseRankings(pasteText);
    if (parsed.length === 0) {
      alert('No players parsed. Make sure your data has a header row with columns like Player, Team, Position, Rank.');
      return;
    }
    setCurrentList(parsed);
    setPasteText('');
    setPasteMode(false);
  };

  const handleAppend = () => {
    const parsed = parseRankings(pasteText);
    if (parsed.length === 0) return;
    setCurrentList(r => [...r, ...parsed]);
    setPasteText('');
  };

  const handleEdit = (id, field, value) => {
    setCurrentList(rs => rs.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const handleDelete = (id) => {
    setCurrentList(rs => rs.filter(r => r.id !== id));
  };

  const handleRenameSource = (newLabel) => {
    setSettings(s => ({
      ...s,
      rankingLabels: { ...(s.rankingLabels || {}), [activeSource]: newLabel },
    }));
  };

  const handleClearSource = () => {
    if (window.confirm(`Clear all rankings in "${settings.rankingLabels?.[activeSource] || activeSource}"?`)) {
      setCurrentList([]);
    }
  };

  const filtered = useMemo(() => {
    return currentList.filter(r => {
      if (filterPos !== 'ALL' && r.pos !== filterPos) return false;
      if (search && !r.player.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [currentList, filterPos, search]);

  const sourceTotal = (key) => key === 'aggregate' ? aggregateRankings.length : (rankingsSources[key]?.length || 0);
  const sourcesLoadedCount = ['rank1', 'rank2', 'rank3'].filter(k => rankingsSources[k]?.length > 0).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-white">Rankings</h1>
          <p className="text-stone-500 text-sm font-mono mt-1">
            {sourcesLoadedCount} of 3 sources loaded
            {sourcesLoadedCount >= 2 && ` • aggregate built from ${sourcesLoadedCount} sources`}
          </p>
        </div>
      </div>

      {/* Source tabs */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-1.5 flex items-center gap-1 flex-wrap">
        {['rank1', 'rank2', 'rank3', 'aggregate'].map(key => {
          const isActive = activeSource === key;
          const count = sourceTotal(key);
          const isAgg = key === 'aggregate';
          const aggDisabled = isAgg && sourcesLoadedCount < 2;
          return (
            <button
              key={key}
              disabled={aggDisabled}
              onClick={() => setActiveSource(key)}
              className={`px-3 py-2 rounded-lg flex items-center gap-2 transition-all ${
                aggDisabled ? 'opacity-30 cursor-not-allowed' :
                isActive
                  ? isAgg ? 'bg-amber-500/15 border border-amber-500/40' : 'bg-cyan-500/15 border border-cyan-500/40'
                  : 'hover:bg-stone-800/50 border border-transparent'
              }`}
            >
              <span className={`font-mono text-xs font-bold uppercase tracking-wider ${
                isActive ? (isAgg ? 'text-amber-300' : 'text-cyan-300') : 'text-stone-400'
              }`}>
                {isAgg && '★ '}{settings.rankingLabels?.[key] || key}
              </span>
              <span className={`font-mono text-[10px] ${isActive ? 'text-stone-300' : 'text-stone-600'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active source controls */}
      {!isAggregate && (
        <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-1">
              <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider">Source name:</div>
              <input
                type="text"
                value={settings.rankingLabels?.[activeSource] || ''}
                onChange={(e) => handleRenameSource(e.target.value)}
                placeholder="e.g. ESPN, FantasyPros, MyRanks"
                className="bg-stone-950 border border-stone-700 rounded px-3 py-1.5 font-mono text-xs text-stone-200 focus:outline-none focus:border-cyan-500/50 max-w-[240px]"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPasteMode(p => !p)}
                className="px-3 py-1.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-mono uppercase tracking-wider flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                {pasteMode ? 'Cancel' : 'Paste'}
              </button>
              {currentList.length > 0 && (
                <button
                  onClick={handleClearSource}
                  className="px-3 py-1.5 rounded bg-stone-900 hover:bg-rose-500/20 border border-stone-700 hover:border-rose-500/30 text-stone-400 hover:text-rose-300 text-xs font-mono uppercase tracking-wider flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isAggregate && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <Star className="w-5 h-5 text-amber-400 fill-amber-400/30 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-mono text-xs text-amber-300 uppercase tracking-wider mb-1">Aggregate Rankings</div>
              <div className="text-stone-300 text-sm">
                Auto-computed from your {sourcesLoadedCount} loaded source{sourcesLoadedCount > 1 ? 's' : ''}. Names are fuzzy-matched across sources (handles A.J. Brown vs AJ Brown, etc.).
                Each player's aggregate rank is the average of their ranks across sources. Players found in fewer sources get a small penalty.
              </div>
              <div className="text-stone-500 text-xs font-mono mt-2">
                Read-only — to change, edit the source rankings.
              </div>
            </div>
          </div>
        </div>
      )}

      {pasteMode && !isAggregate && (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4">
          <div className="font-mono text-xs text-cyan-300 mb-2 uppercase tracking-wider">
            Paste Rankings into "{settings.rankingLabels?.[activeSource] || activeSource}"
          </div>
          <div className="text-stone-400 text-xs mb-3">
            <span className="text-cyan-300">Smart paste:</span> include a header row with any of these column names — <span className="font-mono text-stone-300">Player, Team, Position, Rank, Bye, Tier, Notes</span> — in any order. Position Rank auto-computes from your overall ranks.
            <br />Tab or comma separated.
          </div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`Tier\tPlayer\tPosition\tTeam\tBye\tRank\n1\tJahmyr Gibbs\tRB\tDET\t8\t1\n1\tBijan Robinson\tRB\tATL\t5\t2\n...`}
            className="w-full h-48 bg-stone-950 border border-stone-700 rounded-lg p-3 font-mono text-xs text-stone-100 focus:outline-none focus:border-cyan-500/50 scrollbar-thin"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={handleAppend}
              disabled={!pasteText.trim()}
              className="px-3 py-2 rounded bg-stone-800 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed text-stone-200 text-xs font-mono uppercase tracking-wider"
            >
              Append
            </button>
            <button
              onClick={handlePaste}
              disabled={!pasteText.trim()}
              className="px-4 py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 text-xs font-bold uppercase tracking-wider"
            >
              Replace All
            </button>
          </div>
        </div>
      )}

      {currentList.length > 0 && (
        <>
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search players..."
                className="w-full bg-stone-900 border border-stone-700 rounded pl-9 pr-3 py-2 font-mono text-xs focus:outline-none focus:border-cyan-500/50"
              />
            </div>
            <div className="flex items-center gap-1">
              {['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'].map(pos => (
                <button
                  key={pos}
                  onClick={() => setFilterPos(pos)}
                  className={`px-2.5 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider border ${
                    filterPos === pos
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                      : 'bg-stone-900 text-stone-400 border-stone-800 hover:bg-stone-800'
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-stone-800 overflow-hidden">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full">
                <thead className="bg-stone-900">
                  <tr className="text-[10px] uppercase tracking-wider text-stone-500 font-mono">
                    <th className="text-left py-2 px-3 font-medium w-12">Rk</th>
                    <th className="text-left py-2 px-3 font-medium">Player</th>
                    <th className="text-left py-2 px-3 font-medium w-16">Team</th>
                    <th className="text-left py-2 px-3 font-medium w-16">Pos</th>
                    <th className="text-left py-2 px-3 font-medium w-16">PosRk</th>
                    <th className="text-left py-2 px-3 font-medium w-12">Bye</th>
                    <th className="text-left py-2 px-3 font-medium w-12">Tier</th>
                    <th className="text-left py-2 px-3 font-medium">Notes</th>
                    {!isAggregate && <th className="w-10"></th>}
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-t border-stone-900 hover:bg-stone-900/50">
                      {isAggregate ? (
                        <>
                          <td className="py-1.5 px-3 text-stone-300">{r.overallRank}</td>
                          <td className="py-1.5 px-3 font-semibold text-stone-100">{r.player}</td>
                          <td className="py-1.5 px-3 text-stone-400">{r.team}</td>
                          <td className="py-1.5 px-3"><PosBadge pos={r.pos} size="sm" /></td>
                          <td className="py-1.5 px-3 text-stone-400">{r.pos}{r.posRank}</td>
                          <td className="py-1.5 px-3 text-stone-400">{r.bye || '—'}</td>
                          <td className="py-1.5 px-3 text-stone-700">—</td>
                          <td className="py-1.5 px-3 text-stone-500 text-[10px]">{r.notes}</td>
                        </>
                      ) : (
                        <>
                          <EditableCell value={r.overallRank} onChange={(v) => handleEdit(r.id, 'overallRank', parseInt(v) || 0)} type="number" />
                          <EditableCell value={r.player} onChange={(v) => handleEdit(r.id, 'player', v)} className="font-semibold text-stone-100" />
                          <EditableCell value={r.team} onChange={(v) => handleEdit(r.id, 'team', v)} />
                          <td className="py-1.5 px-3"><PosBadge pos={r.pos} size="sm" /></td>
                          <EditableCell value={r.posRank || ''} onChange={(v) => handleEdit(r.id, 'posRank', parseInt(v) || null)} type="number" />
                          <EditableCell value={r.bye || ''} onChange={(v) => handleEdit(r.id, 'bye', parseInt(v) || null)} type="number" />
                          <EditableCell value={r.tier || ''} onChange={(v) => handleEdit(r.id, 'tier', parseInt(v) || null)} type="number" />
                          <EditableCell value={r.notes} onChange={(v) => handleEdit(r.id, 'notes', v)} />
                          <td className="py-1.5 px-2">
                            <button onClick={() => handleDelete(r.id)} className="text-stone-600 hover:text-rose-400">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {currentList.length === 0 && !pasteMode && (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-dashed border-stone-800">
          <BarChart3 className="w-12 h-12 text-stone-700 mb-3" />
          <div className="font-display text-xl text-stone-400 mb-2">
            {isAggregate ? 'Need at least 2 sources to build aggregate' : `No rankings in "${settings.rankingLabels?.[activeSource] || activeSource}"`}
          </div>
          <div className="text-stone-600 text-sm font-mono">
            {isAggregate ? 'Load rankings into rank1, rank2, or rank3 to see aggregate here' : 'Click Paste above to add rankings'}
          </div>
        </div>
      )}
    </div>
  );
}

function EditableCell({ value, onChange, type = 'text', className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    onChange(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <td className="py-1.5 px-3">
        <input
          type={type}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
          className="w-full bg-stone-950 border border-cyan-500/50 rounded px-1.5 py-0.5 font-mono text-xs focus:outline-none"
        />
      </td>
    );
  }

  return (
    <td onClick={() => setEditing(true)} className={`py-1.5 px-3 cursor-pointer text-stone-300 ${className}`}>
      {value || <span className="text-stone-700">—</span>}
    </td>
  );
}

// ==================== ADP VIEW ====================
function AdpView({ adp, setAdp, settings, setSettings, rankings }) {
  const [pasteText, setPasteText] = useState('');
  const [pasteMode, setPasteMode] = useState(Object.keys(adp).length === 0);
  const [targetSlot, setTargetSlot] = useState('adp1');
  const [sourceName, setSourceName] = useState('');

  const handlePaste = () => {
    const parsed = parseAdp(pasteText, targetSlot);
    if (Object.keys(parsed).length === 0) {
      alert('No ADP data parsed. Make sure your data has a header row with at least a Player column and an ADP/ESPN/Sleeper-style column.');
      return;
    }

    // Merge with existing adp data — preserve other slot values
    const merged = { ...adp };
    Object.entries(parsed).forEach(([key, vals]) => {
      merged[key] = { ...(merged[key] || { adp1: null, adp2: null, adp3: null }), ...vals };
    });

    // If user named the source, save the label
    if (sourceName.trim()) {
      setSettings(s => ({
        ...s,
        adpLabels: { ...(s.adpLabels || {}), [targetSlot]: sourceName.trim() }
      }));
    }

    setAdp(merged);
    setPasteText('');
    setSourceName('');
    setPasteMode(false);
  };

  const adpEntries = Object.entries(adp);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-white">ADP</h1>
          <p className="text-stone-500 text-sm font-mono mt-1">{adpEntries.length} players have ADP data</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPasteMode(p => !p)}
            className="px-3 py-2 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-mono uppercase tracking-wider flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            {pasteMode ? 'Cancel' : 'Paste ADP'}
          </button>
          {adpEntries.length > 0 && (
            <button
              onClick={() => { if (window.confirm('Clear all ADP data?')) setAdp({}); }}
              className="px-3 py-2 rounded bg-stone-900 hover:bg-rose-500/20 border border-stone-700 hover:border-rose-500/30 text-stone-400 hover:text-rose-300 text-xs font-mono uppercase tracking-wider flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Active ADP selector */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-4">
        <div className="font-mono text-xs text-stone-500 uppercase tracking-wider mb-3">Active Source (per-league)</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {['adp1', 'adp2', 'adp3'].map(key => {
            const slotPlayerCount = adpEntries.filter(([_, v]) => v[key] != null).length;
            return (
              <div key={key} className={`p-3 rounded-lg border transition-all cursor-pointer ${
                settings.activeAdp === key
                  ? 'bg-cyan-500/10 border-cyan-500/40'
                  : 'bg-stone-900 border-stone-800 hover:border-stone-700'
              }`} onClick={() => setSettings(s => ({ ...s, activeAdp: key }))}>
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                    settings.activeAdp === key ? 'bg-cyan-400 border-cyan-400' : 'border-stone-600'
                  }`} />
                  <input
                    type="text"
                    value={settings.adpLabels?.[key] || ''}
                    onChange={(e) => setSettings(s => ({
                      ...s,
                      adpLabels: { ...(s.adpLabels || {}), [key]: e.target.value }
                    }))}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-transparent border-none outline-none font-mono text-xs text-stone-200 font-bold flex-1 min-w-0"
                  />
                </div>
                <div className="font-mono text-[10px] text-stone-500">
                  {slotPlayerCount > 0 ? `${slotPlayerCount} players` : 'empty'} • used for value calcs
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {pasteMode && (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4">
          <div className="font-mono text-xs text-cyan-300 mb-3 uppercase tracking-wider">Paste ADP</div>

          {/* Target slot + source name */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider mb-1">Import Into Slot</div>
              <div className="grid grid-cols-3 gap-1">
                {['adp1', 'adp2', 'adp3'].map(slot => (
                  <button
                    key={slot}
                    onClick={() => setTargetSlot(slot)}
                    className={`px-3 py-2 rounded text-xs font-mono uppercase tracking-wider border transition-all ${
                      targetSlot === slot
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'bg-stone-950 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                  >
                    {settings.adpLabels?.[slot] || slot.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider mb-1">Rename This Slot (optional)</div>
              <input
                type="text"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder="e.g. ESPN, Sleeper, Underdog"
                className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
              />
            </div>
          </div>

          <div className="text-stone-400 text-xs mb-3">
            <span className="text-cyan-300">Smart paste:</span> include a header row. Common formats accepted:
            <br /><span className="font-mono text-stone-300">Player, Position, Team, ESPN</span> or <span className="font-mono text-stone-300">Player, Position, ADP</span> — any order. Standard deviation in parens (e.g. <span className="font-mono">2.00 (0.20)</span>) is auto-stripped.
          </div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`#\tPlayer\tPosition\tTeam\tESPN\n1\tBijan Robinson\tRB\tATL\t2.00 (0.20)\n2\tJahmyr Gibbs\tRB\tDET\t2.40 (0.20)\n...`}
            className="w-full h-48 bg-stone-950 border border-stone-700 rounded-lg p-3 font-mono text-xs text-stone-100 focus:outline-none focus:border-cyan-500/50 scrollbar-thin"
          />
          <div className="flex justify-between items-center mt-3">
            <div className="font-mono text-[10px] text-stone-500">
              Importing into <span className="text-cyan-300 font-bold">{settings.adpLabels?.[targetSlot] || targetSlot.toUpperCase()}</span>
            </div>
            <button
              onClick={handlePaste}
              disabled={!pasteText.trim()}
              className="px-4 py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 text-xs font-bold uppercase tracking-wider"
            >
              Import ADP
            </button>
          </div>
        </div>
      )}

      {adpEntries.length > 0 && (
        <div className="rounded-xl border border-stone-800 overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin max-h-[600px]">
            <table className="w-full">
              <thead className="bg-stone-900 sticky top-0">
                <tr className="text-[10px] uppercase tracking-wider text-stone-500 font-mono">
                  <th className="text-left py-2 px-3 font-medium">Player</th>
                  <th className="text-left py-2 px-3 font-medium">{settings.adpLabels?.adp1 || 'ADP 1'}</th>
                  <th className="text-left py-2 px-3 font-medium">{settings.adpLabels?.adp2 || 'ADP 2'}</th>
                  <th className="text-left py-2 px-3 font-medium">{settings.adpLabels?.adp3 || 'ADP 3'}</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {adpEntries
                  .sort((a, b) => (a[1][settings.activeAdp] || 999) - (b[1][settings.activeAdp] || 999))
                  .map(([key, vals]) => {
                    const ranked = rankings.find(r => r.player.toLowerCase() === key);
                    return (
                      <tr key={key} className="border-t border-stone-900 hover:bg-stone-900/50">
                        <td className="py-1.5 px-3 font-semibold text-stone-100">
                          {ranked?.player || key}
                        </td>
                        <td className={`py-1.5 px-3 ${settings.activeAdp === 'adp1' ? 'text-cyan-300 font-bold' : 'text-stone-400'}`}>
                          {vals.adp1 != null ? vals.adp1.toFixed(1) : '—'}
                        </td>
                        <td className={`py-1.5 px-3 ${settings.activeAdp === 'adp2' ? 'text-cyan-300 font-bold' : 'text-stone-400'}`}>
                          {vals.adp2 != null ? vals.adp2.toFixed(1) : '—'}
                        </td>
                        <td className={`py-1.5 px-3 ${settings.activeAdp === 'adp3' ? 'text-cyan-300 font-bold' : 'text-stone-400'}`}>
                          {vals.adp3 != null ? vals.adp3.toFixed(1) : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== TARGETS VIEW ====================
function TargetsView({ targets, setTargets, rankings, draftedSet }) {
  const [newPlayer, setNewPlayer] = useState('');
  const [newPriority, setNewPriority] = useState(2);
  const [newNotes, setNewNotes] = useState('');
  const [suggestions, setSuggestions] = useState([]);

  const handleAdd = () => {
    if (!newPlayer.trim()) return;
    const id = `t-${Date.now()}`;
    setTargets(t => [...t, {
      id,
      player: newPlayer.trim(),
      priority: newPriority,
      notes: newNotes,
    }]);
    setNewPlayer('');
    setNewNotes('');
    setSuggestions([]);
  };

  const handleDelete = (id) => {
    setTargets(t => t.filter(x => x.id !== id));
  };

  const handleEdit = (id, field, value) => {
    setTargets(ts => ts.map(t => t.id === id ? { ...t, [field]: value } : t));
  };

  const handlePlayerChange = (val) => {
    setNewPlayer(val);
    if (val.length < 2) {
      setSuggestions([]);
      return;
    }
    const matches = rankings
      .filter(r => r.player.toLowerCase().includes(val.toLowerCase()))
      .slice(0, 5);
    setSuggestions(matches);
  };

  const sorted = [...targets].sort((a, b) => (a.priority || 99) - (b.priority || 99));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-white">Targets</h1>
          <p className="text-stone-500 text-sm font-mono mt-1">{targets.length} players on your watchlist</p>
        </div>
      </div>

      {/* Add target */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-4">
        <div className="font-mono text-xs text-stone-500 uppercase tracking-wider mb-3">Add Target</div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
          <div className="md:col-span-4 relative">
            <input
              type="text"
              value={newPlayer}
              onChange={(e) => handlePlayerChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Player name..."
              className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
            />
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border border-stone-700 rounded-lg shadow-2xl z-10 overflow-hidden">
                {suggestions.map(s => (
                  <button
                    key={s.id}
                    onClick={() => { setNewPlayer(s.player); setSuggestions([]); }}
                    className="w-full text-left px-3 py-2 hover:bg-stone-800 text-sm flex items-center gap-2"
                  >
                    <PosBadge pos={s.pos} size="sm" />
                    <span>{s.player}</span>
                    <span className="text-stone-500 text-xs ml-auto">#{s.overallRank}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="md:col-span-2">
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(parseInt(e.target.value))}
              className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
            >
              <option value={1}>1 — Must Have</option>
              <option value={2}>2 — Like</option>
              <option value={3}>3 — Dart Throw</option>
            </select>
          </div>
          <div className="md:col-span-5">
            <input
              type="text"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Notes (optional)"
              className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={!newPlayer.trim()}
            className="md:col-span-1 px-3 py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      {targets.length > 0 && (
        <div className="rounded-xl border border-stone-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-stone-900">
              <tr className="text-[10px] uppercase tracking-wider text-stone-500 font-mono">
                <th className="text-left py-2 px-3 font-medium w-16">Pri</th>
                <th className="text-left py-2 px-3 font-medium">Player</th>
                <th className="text-left py-2 px-3 font-medium w-16">Pos</th>
                <th className="text-left py-2 px-3 font-medium">Notes</th>
                <th className="text-left py-2 px-3 font-medium w-24">Status</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {sorted.map(t => {
                const playerData = rankings.find(r => r.player.toLowerCase() === t.player.toLowerCase());
                const isDrafted = draftedSet.has(t.player.toLowerCase());
                return (
                  <tr key={t.id} className={`border-t border-stone-900 ${isDrafted ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-3">
                      <select
                        value={t.priority}
                        onChange={(e) => handleEdit(t.id, 'priority', parseInt(e.target.value))}
                        className={`bg-transparent border-none outline-none font-mono text-xs font-bold cursor-pointer ${
                          t.priority === 1 ? 'text-amber-300' :
                          t.priority === 2 ? 'text-violet-300' : 'text-stone-400'
                        }`}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                    </td>
                    <td className="py-2 px-3 font-semibold text-stone-100">{t.player}</td>
                    <td className="py-2 px-3">{playerData && <PosBadge pos={playerData.pos} size="sm" />}</td>
                    <td className="py-2 px-3 text-stone-400">{t.notes || <span className="text-stone-700">—</span>}</td>
                    <td className="py-2 px-3">
                      {isDrafted ? (
                        <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold">DRAFTED</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">AVAILABLE</span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <button onClick={() => handleDelete(t.id)} className="text-stone-600 hover:text-rose-400">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ==================== DRAFT BOARD VIEW ====================
function DraftBoardView({ settings, draft, rankings, onDraft, onUndraft, onReset, currentPick }) {
  const totalPicks = settings.numTeams * settings.numRounds;
  const picks = [];
  for (let p = 1; p <= totalPicks; p++) {
    const team = computeTeamForPick(p, settings.numTeams);
    const round = Math.ceil(p / settings.numTeams);
    const player = draft[p];
    const playerData = player ? rankings.find(r => r.player.toLowerCase() === player.toLowerCase()) : null;
    picks.push({ pick: p, round, team, player, pos: playerData?.pos });
  }

  // Group by round for grid display
  const rounds = [];
  for (let r = 1; r <= settings.numRounds; r++) {
    rounds.push(picks.filter(p => p.round === r));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-white">Draft Board</h1>
          <p className="text-stone-500 text-sm font-mono mt-1">
            {Object.keys(draft).filter(k => draft[k]).length} of {totalPicks} picks made • Snake order
          </p>
        </div>
        <button
          onClick={onReset}
          className="px-3 py-2 rounded bg-stone-900 hover:bg-rose-500/20 border border-stone-700 hover:border-rose-500/30 text-stone-400 hover:text-rose-300 text-xs font-mono uppercase tracking-wider flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reset Draft
        </button>
      </div>

      {/* Team headers */}
      <div className="rounded-xl border border-stone-800 bg-stone-900/30 overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <div className="min-w-max">
            {/* Header row */}
            <div className="grid border-b border-stone-800" style={{ gridTemplateColumns: `60px repeat(${settings.numTeams}, minmax(140px, 1fr))` }}>
              <div className="p-2 font-mono text-[10px] uppercase tracking-wider text-stone-500 text-center">Rd</div>
              {Array.from({ length: settings.numTeams }, (_, i) => i + 1).map(t => (
                <div key={t} className={`p-2 font-mono text-[10px] uppercase tracking-wider text-center ${
                  t === settings.myPick ? 'text-amber-300 bg-amber-500/10 font-bold' : 'text-stone-400'
                }`}>
                  Team {t}{t === settings.myPick && ' (you)'}
                </div>
              ))}
            </div>

            {/* Round rows */}
            {rounds.map((roundPicks, idx) => (
              <div key={idx} className="grid border-b border-stone-900" style={{ gridTemplateColumns: `60px repeat(${settings.numTeams}, minmax(140px, 1fr))` }}>
                <div className="p-2 font-mono text-xs text-stone-500 text-center font-bold flex items-center justify-center">
                  {idx + 1}
                </div>
                {Array.from({ length: settings.numTeams }, (_, i) => i + 1).map(teamSlot => {
                  // Find the pick that belongs to this (round, team) cell
                  const pick = roundPicks.find(p => p.team === teamSlot);
                  if (!pick) return <div key={teamSlot} className="p-2" />;
                  return <DraftCell key={pick.pick} pick={pick} isMine={pick.team === settings.myPick} isCurrent={pick.pick === currentPick} onDraft={onDraft} onUndraft={onUndraft} rankings={rankings} />;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftCell({ pick, isMine, isCurrent, onDraft, onUndraft, rankings }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(pick.player || '');
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => setValue(pick.player || ''), [pick.player]);

  const handleChange = (val) => {
    setValue(val);
    if (val.length < 2) { setSuggestions([]); return; }
    const matches = rankings
      .filter(r => r.player.toLowerCase().includes(val.toLowerCase()))
      .slice(0, 5);
    setSuggestions(matches);
  };

  const commit = (playerName) => {
    if (playerName) onDraft(pick.pick, playerName);
    setEditing(false);
    setSuggestions([]);
  };

  if (editing) {
    return (
      <div className="p-1 relative">
        <input
          type="text"
          value={value}
          autoFocus
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(suggestions[0]?.player || value);
            if (e.key === 'Escape') { setEditing(false); setSuggestions([]); }
          }}
          onBlur={() => { setTimeout(() => { setEditing(false); setSuggestions([]); }, 150); }}
          placeholder={`#${pick.pick}`}
          className="w-full bg-stone-950 border border-cyan-500/50 rounded px-1.5 py-1 text-xs focus:outline-none"
        />
        {suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border border-stone-700 rounded-lg shadow-2xl z-20 overflow-hidden">
            {suggestions.map(s => (
              <button
                key={s.id}
                onMouseDown={(e) => { e.preventDefault(); commit(s.player); }}
                className="w-full text-left px-2 py-1.5 hover:bg-stone-800 text-xs flex items-center gap-1.5"
              >
                <PosBadge pos={s.pos} size="sm" />
                <span className="truncate">{s.player}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const cellClass = `p-1.5 border-l border-stone-900 cursor-pointer transition-all ${
    pick.player
      ? isMine
        ? 'bg-amber-500/15 hover:bg-amber-500/25'
        : 'bg-stone-900/30 hover:bg-stone-800'
      : isCurrent
        ? 'bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40'
        : 'hover:bg-stone-900'
  }`;

  return (
    <div className={cellClass} onClick={() => setEditing(true)}>
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <span className="font-mono text-[9px] text-stone-500">#{pick.pick}</span>
        {pick.player && (
          <button
            onClick={(e) => { e.stopPropagation(); onUndraft(pick.pick); }}
            className="text-stone-600 hover:text-rose-400 opacity-0 hover:opacity-100 group-hover:opacity-100"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
      {pick.player ? (
        <div>
          <div className="text-xs font-semibold text-stone-100 truncate leading-tight">{pick.player}</div>
          <div className="mt-0.5">{pick.pos && <PosBadge pos={pick.pos} size="sm" />}</div>
        </div>
      ) : (
        <div className={`text-[10px] font-mono italic ${isCurrent ? 'text-cyan-400 font-bold' : 'text-stone-700'}`}>
          {isCurrent ? 'On clock' : 'click to add'}
        </div>
      )}
    </div>
  );
}

// ==================== SETTINGS VIEW ====================
function SettingsView({ settings, setSettings, onClearAll, onResetDraft }) {
  const update = (path, value) => {
    setSettings(s => {
      const next = { ...s };
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...obj[keys[i]] };
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="font-display text-3xl text-white">Settings</h1>
        <p className="text-stone-500 text-sm font-mono mt-1">Configure your league for this draft</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* League */}
        <Panel title="League" icon={<Users className="w-4 h-4" />} accent="cyan">
          <div className="space-y-3">
            <SettingField label="League Name" value={settings.leagueName} onChange={(v) => update('leagueName', v)} />
            <SettingField label="Number of Teams" value={settings.numTeams} onChange={(v) => update('numTeams', parseInt(v) || 12)} type="number" />
            <SettingField label="My Pick #" value={settings.myPick} onChange={(v) => update('myPick', parseInt(v) || 1)} type="number" />
            <SettingField label="Number of Rounds" value={settings.numRounds} onChange={(v) => update('numRounds', parseInt(v) || 16)} type="number" />
            <div>
              <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider mb-1">Scoring Format</div>
              <select
                value={settings.scoringFormat}
                onChange={(e) => update('scoringFormat', e.target.value)}
                className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
              >
                <option>Full PPR</option>
                <option>Half PPR</option>
                <option>Standard</option>
              </select>
            </div>
          </div>
        </Panel>

        {/* Roster */}
        <Panel title="Roster Slots" icon={<Crown className="w-4 h-4" />} accent="amber">
          <div className="space-y-2">
            {['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BENCH'].map(pos => (
              <div key={pos} className="flex items-center gap-3">
                <span className="font-mono text-xs w-16 text-stone-400">{pos}</span>
                <input
                  type="number"
                  min="0"
                  value={settings.roster[pos] || 0}
                  onChange={(e) => update(`roster.${pos}`, parseInt(e.target.value) || 0)}
                  className="w-20 bg-stone-950 border border-stone-700 rounded px-2 py-1 font-mono text-sm focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            ))}
            <div className="pt-2 mt-2 border-t border-stone-800 flex items-center gap-3">
              <span className="font-mono text-xs w-16 text-amber-300 font-bold">TOTAL</span>
              <span className="font-mono text-sm text-stone-200">
                {Object.values(settings.roster).reduce((a, b) => a + b, 0)}
              </span>
            </div>
          </div>
        </Panel>

        {/* Value Thresholds */}
        <Panel title="Value Thresholds" icon={<TrendingUp className="w-4 h-4" />} accent="emerald">
          <div className="space-y-3">
            <SettingField label="Steal (picks past ADP)" value={settings.thresholds.steal} onChange={(v) => update('thresholds.steal', parseInt(v) || 12)} type="number" hint="Player available 12+ picks after ADP" />
            <SettingField label="Value (picks past ADP)" value={settings.thresholds.value} onChange={(v) => update('thresholds.value', parseInt(v) || 6)} type="number" hint="Player available 6+ picks after ADP" />
            <SettingField label="Reach (picks before ADP)" value={settings.thresholds.reach} onChange={(v) => update('thresholds.reach', parseInt(v) || 6)} type="number" hint="Drafted 6+ picks before ADP" />
          </div>
        </Panel>

        {/* Dynamic Ranking Weights */}
        <Panel title="Dynamic Ranking" icon={<Activity className="w-4 h-4" />} accent="violet">
          <div className="space-y-3">
            <SettingField label="Roster Need Weight" value={settings.weights.rosterNeed} onChange={(v) => update('weights.rosterNeed', parseFloat(v) || 0)} type="number" hint="Max bump for unmet roster need" />
            <SettingField label="Tier Scarcity Weight" value={settings.weights.scarcity} onChange={(v) => update('weights.scarcity', parseFloat(v) || 0)} type="number" hint="Max bump when position is running" />
            <SettingField label="Run Momentum Weight" value={settings.weights.run} onChange={(v) => update('weights.run', parseFloat(v) || 0)} type="number" hint="Max bump for active position runs" />
          </div>
        </Panel>
      </div>

      {/* Danger zone */}
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
        <div className="font-mono text-xs text-rose-300 uppercase tracking-wider mb-3 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          Danger Zone
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onResetDraft}
            className="px-3 py-2 rounded bg-stone-900 hover:bg-rose-500/20 border border-stone-700 hover:border-rose-500/40 text-stone-300 hover:text-rose-200 text-xs font-mono uppercase tracking-wider"
          >
            Reset Draft (keep rankings)
          </button>
          <button
            onClick={onClearAll}
            className="px-3 py-2 rounded bg-stone-900 hover:bg-rose-500/20 border border-stone-700 hover:border-rose-500/40 text-stone-300 hover:text-rose-200 text-xs font-mono uppercase tracking-wider"
          >
            Clear EVERYTHING
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingField({ label, value, onChange, type = 'text', hint }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-stone-500 uppercase tracking-wider mb-1">{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
      />
      {hint && <div className="font-mono text-[10px] text-stone-600 mt-1">{hint}</div>}
    </div>
  );
}
