import { useRef, useState } from "react";
import {
  Microscope, Search, Database, Dna, FlaskConical,
  ChevronRight, ArrowRight, Menu, X, History,
  Atom, Activity, ShieldCheck, ExternalLink,
  ArrowUpRight, Layers, Network, CircleHelp, Clock3
} from "lucide-react";
import { resolvePubChemCompound, resolveChemblMoleculeByInchiKey, retrieveChemblActivities, retrievePfProteinTargets, ApiError } from "./api.js";
import "./App.css";

const suggestedCompounds = ["Chloroquine", "Artemisinin", "Pyrimethamine", "Mefloquine"];

const databases = [
  { name: "PubChem", description: "Chemical structures, identifiers and molecular properties.", tag: "Compound database", status: "LIVE INTEGRATION", icon: Database },
  { name: "ChEMBL", description: "Compound records, curated mechanisms, target metadata and supporting malaria bioactivity evidence.", tag: "Compound and target database", status: "LIVE MOLECULE + PROTEIN EVIDENCE", icon: Activity },
  { name: "ZINC", description: "Chemical compounds and ligand discovery resources.", tag: "Chemical database", status: "PLANNED INTEGRATION", icon: FlaskConical },
  { name: "PlasmoDB", description: "Genomic and protein information for malaria parasites.", tag: "Genomics database", status: "LATER INTEGRATION", icon: Dna }
];

const workflow = [
  { number: "01", title: "Compound input", description: "Submit a compound using its name, CID or SMILES.", icon: FlaskConical },
  { number: "02", title: "Compound identification", description: "Resolve the compound identity through live chemical databases.", icon: Database },
  { number: "03", title: "Candidate target extraction", description: "Retrieve associated biological proteins, identifiers and sequences.", icon: Network },
  { number: "04", title: "Sequence screening", description: "A later extension can compare sequences against the malaria proteome.", icon: Dna },
  { number: "05", title: "Evidence review", description: "Explore source-linked evidence without overstating target validation.", icon: Layers }
];

const ACTIVITY_RECORDS_PER_VIEW = 25;

function ActivityTargetGroup({ group }) {
  const [isOpen, setIsOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_RECORDS_PER_VIEW);
  const visibleActivities = group.activities.slice(0, visibleCount);

  return (
    <details
      className="activity-target-group"
      onToggle={event => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <div className="activity-target-title">
          <strong>{group.targetName || (group.targetChemblId ? "Target name not supplied by ChEMBL" : "Target ID not supplied by ChEMBL")}</strong>
          <span>{group.targetChemblId || "UNASSIGNED TARGET"}</span>
          <small>{group.targetOrganism || "Organism not supplied"}{group.targetType ? ` · ${group.targetType}` : ""}</small>
        </div>
        <span className="activity-count">{group.recordCount} record{group.recordCount === 1 ? "" : "s"}</span>
      </summary>
      {isOpen && (
        <>
          <div className="activity-record-list">
            {visibleActivities.map((activity, activityIndex) => (
              <article className="activity-record" key={activity.activityId || `${group.key}-${activityIndex}`}>
                <div className="activity-record-heading">
                  <strong>{activity.standardType || "Activity endpoint not supplied"}</strong>
                  {activity.activityId && <a href={`https://www.ebi.ac.uk/chembl/activity_report_card/${encodeURIComponent(activity.activityId)}/`} target="_blank" rel="noreferrer">Activity #{activity.activityId} <ExternalLink size={11}/></a>}
                </div>
                <div className="activity-values-grid">
                  <div><span>STANDARD RELATION / VALUE</span><strong>{[activity.standardRelation, activity.standardValue, activity.standardUnits].filter(value => value !== null && value !== "").join(" ") || "Not reported"}</strong></div>
                  <div><span>STANDARD TEXT VALUE</span><strong>{activity.standardTextValue ?? "Not reported"}</strong></div>
                  <div><span>pChEMBL VALUE</span><strong>{activity.pchemblValue ?? "Not reported"}</strong></div>
                  <div><span>ASSAY</span><strong>{activity.assayChemblId || "Not reported"}</strong></div>
                </div>
                {activity.assayDescription && <p>{activity.assayDescription}</p>}
                <div className="activity-record-links">
                  {activity.assayChemblId && <a href={`https://www.ebi.ac.uk/chembl/assay_report_card/${encodeURIComponent(activity.assayChemblId)}/`} target="_blank" rel="noreferrer">View assay <ExternalLink size={11}/></a>}
                  {activity.documentChemblId && <a href={`https://www.ebi.ac.uk/chembl/document_report_card/${encodeURIComponent(activity.documentChemblId)}/`} target="_blank" rel="noreferrer">View publication record <ExternalLink size={11}/></a>}
                  {activity.journal && <span>{activity.journal}{activity.publicationYear ? ` (${activity.publicationYear})` : ""}</span>}
                </div>
                {activity.activityComment && <small>ChEMBL comment: {activity.activityComment}</small>}
                {activity.dataValidityComment && <small>Data validity: {activity.dataValidityComment}</small>}
              </article>
            ))}
          </div>
          <div className="activity-record-pagination">
            <span>Showing {visibleActivities.length.toLocaleString()} of {group.recordCount.toLocaleString()} records</span>
            {visibleCount < group.activities.length && (
              <button type="button" className="secondary-btn" onClick={() => setVisibleCount(count => Math.min(count + ACTIVITY_RECORDS_PER_VIEW, group.activities.length))}>
                Show next {Math.min(ACTIVITY_RECORDS_PER_VIEW, group.activities.length - visibleCount)} records
              </button>
            )}
          </div>
        </>
      )}
    </details>
  );
}


function ProteinCandidateCard({ protein, mechanismStatus = "available" }) {
  const [showSequence, setShowSequence] = useState(false);
  const sequence = protein.uniprot?.sequence || null;
  const title = protein.uniprot?.proteinName || protein.name || "Protein name not supplied";
  return (
    <article className="protein-candidate-card">
      <div className="protein-candidate-header">
        <div>
          <strong>{title}</strong>
          {protein.uniprot?.geneName && <span className="protein-gene">Gene: {protein.uniprot.geneName}</span>}
          <small>{protein.chemblId} · {protein.targetType || "Target type unavailable"} · {protein.organism || "Organism unavailable"}</small>
        </div>
        <span className="protein-record-count">{mechanismStatus === "unavailable" ? "MOA unavailable" : mechanismStatus === "partial" ? `${protein.mechanismCount} MOA · partial` : `${protein.mechanismCount} MOA`} · {protein.activityCount} activity</span>
      </div>
      <div className="protein-metadata-grid">
        <div><span>UNIPROT ACCESSION</span><strong>{protein.accession || "Not supplied"}</strong></div>
        <div><span>SEQUENCE LENGTH</span><strong>{sequence ? `${protein.uniprot.sequenceLength} aa` : "Not retrieved"}</strong></div>
        <div><span>UNIPROT ORGANISM</span><strong>{protein.uniprot?.organism || "Not confirmed"}</strong></div>
        <div><span>GENE</span><strong>{protein.uniprot?.geneName || "Not supplied"}</strong></div>
      </div>
      <div className="protein-candidate-links">
        {protein.accession && <a href={`https://www.uniprot.org/uniprotkb/${encodeURIComponent(protein.accession)}/entry`} target="_blank" rel="noreferrer">Open UniProtKB entry <ExternalLink size={11}/></a>}
        {protein.chemblId && <a href={`https://www.ebi.ac.uk/chembl/target_report_card/${encodeURIComponent(protein.chemblId)}/`} target="_blank" rel="noreferrer">Open ChEMBL target <ExternalLink size={11}/></a>}
      </div>
      {protein.candidateStatus && <p className="stage-note">{protein.candidateStatus}</p>}
      {sequence ? (
        <>
          <button type="button" className="secondary-btn sequence-toggle" onClick={() => setShowSequence(open => !open)}>
            {showSequence ? "Hide protein sequence" : "Show protein sequence"}
          </button>
          {showSequence && <pre className="protein-sequence">&gt;{protein.accession} | {title} | {protein.uniprot.organism}{"\n"}{sequence.match(/.{1,60}/g)?.join("\n") || sequence}</pre>}
        </>
      ) : (
        <p className="protein-sequence-warning">{protein.sequenceError || "UniProt did not return a sequence for this candidate."}</p>
      )}
      {protein.mechanisms?.length > 0 && (
        <div className="protein-evidence-summary protein-mechanism-summary">
          <strong>ChEMBL mechanism-of-action annotations</strong>
          {protein.mechanisms.map((item, index) => (
            <span key={item.recordId || index}>
              {item.mechanismOfAction || "Mechanism not described"}
              {item.actionType ? ` · ${item.actionType}` : ""}
              {item.directInteraction === true ? " · ChEMBL flags direct interaction" : item.directInteraction === false ? " · ChEMBL does not flag direct interaction" : " · Direct-interaction status not supplied"}
            </span>
          ))}
        </div>
      )}
      {protein.evidence?.length > 0 && (
        <div className="protein-evidence-summary">
          <strong>ChEMBL evidence measurements</strong>
          {protein.evidence.slice(0, 4).map((item, index) => (
            <span key={item.activityId || index}>
              {item.standardType || "Measurement not specified"}: {[item.relation, item.value, item.units].filter(Boolean).join(" ") || "Value not reported"}
              {item.pchemblValue ? ` · pChEMBL ${item.pchemblValue}` : ""}
            </span>
          ))}
          {protein.evidence.length > 4 && <small>Showing 4 of {protein.evidence.length} linked records.</small>}
        </div>
      )}
    </article>
  );
}

function App() {
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState("Name");
  const [result, setResult] = useState(null);
  const [matches, setMatches] = useState([]);
  const [matchInfo, setMatchInfo] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [activeController, setActiveController] = useState(null);
  const [chemblResult, setChemblResult] = useState(null);
  const [chemblLoading, setChemblLoading] = useState(false);
  const [chemblError, setChemblError] = useState("");
  const [selectedChemblId, setSelectedChemblId] = useState(null);
  const [activityResult, setActivityResult] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [activityProgress, setActivityProgress] = useState(null);
  const [proteinResult, setProteinResult] = useState(null);
  const [proteinLoading, setProteinLoading] = useState(false);
  const [proteinError, setProteinError] = useState("");
  const [proteinProgress, setProteinProgress] = useState(null);
  const chemblControllerRef = useRef(null);
  const activityControllerRef = useRef(null);
  const proteinControllerRef = useRef(null);
  const activityProbeUrl = selectedChemblId
    ? `/api/chembl?${new URLSearchParams({
        endpoint: "activity",
        molecule_chembl_id: selectedChemblId,
        limit: "1",
        offset: "0",
        format: "json"
      }).toString()}`
    : null;

  async function searchCompound(value = query, type = searchType) {
    const input = String(value ?? "").trim();
    if (!input) {
      setError("Enter a compound name, PubChem CID or SMILES string.");
      return;
    }

    activeController?.abort();
    chemblControllerRef.current?.abort();
    activityControllerRef.current?.abort();
    proteinControllerRef.current?.abort();
    activityControllerRef.current = null;
    proteinControllerRef.current = null;
    chemblControllerRef.current = null;
    setProteinResult(null);
    setProteinError("");
    setProteinProgress(null);
    setProteinLoading(false);
    setActivityResult(null);
    setActivityError("");
    setActivityProgress(null);
    setActivityLoading(false);
    setChemblResult(null);
    setChemblLoading(false);
    setChemblError("");
    setSelectedChemblId(null);
    const controller = new AbortController();
    setActiveController(controller);
    setQuery(input);
    setSearchType(type);
    setLoading(true);
    setError("");
    setResult(null);
    setMatches([]);
    setMatchInfo(null);

    try {
      const response = await resolvePubChemCompound(input, type, { signal: controller.signal });
      if (controller.signal.aborted) return;

      if (!response.compounds.length) {
        throw new ApiError("PubChem returned no matching compound properties.", { code: "NOT_FOUND" });
      }

      const info = {
        input: response.input,
        inputType: response.inputType,
        retrievedAt: response.retrievedAt,
        totalMatches: response.totalMatches,
        truncated: response.truncated,
        propertyUrl: response.propertyUrl
      };
      setMatchInfo(info);

      if (response.compounds.length === 1) {
        chooseCompound(response.compounds[0], info);
      } else {
        setMatches(response.compounds);
      }

      setHistory(previous => {
        const entry = { input, type, label: `${input} (${type})` };
        return [entry, ...previous.filter(item => !(item.input === input && item.type === type))].slice(0, 6);
      });

      window.setTimeout(() => {
        if (!controller.signal.aborted) {
          document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 80);
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && !controller.signal.aborted) {
        setError(requestError?.message || "An unexpected error occurred while contacting PubChem.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      setActiveController(current => current === controller ? null : current);
    }
  }

  async function chooseCompound(compound, info = matchInfo) {
    if (!compound) return;
    chemblControllerRef.current?.abort();
    activityControllerRef.current?.abort();
    proteinControllerRef.current?.abort();
    activityControllerRef.current = null;
    proteinControllerRef.current = null;
    setProteinResult(null);
    setProteinError("");
    setProteinProgress(null);
    setProteinLoading(false);
    setActivityResult(null);
    setActivityError("");
    setActivityProgress(null);
    setActivityLoading(false);
    const selected = {
      ...compound,
      retrievedAt: info?.retrievedAt || new Date().toISOString(),
      input: info?.input || query,
      inputType: info?.inputType || searchType,
      totalMatches: info?.totalMatches || 1
    };
    setResult(selected);
    setMatches([]);
    setChemblLoading(false);
    setChemblResult(null);
    setChemblError("");
    setSelectedChemblId(null);

    if (!selected.inchiKey) {
      setChemblError("PubChem did not provide an InChIKey for this record. Exact ChEMBL matching cannot be performed.");
      return;
    }

    const controller = new AbortController();
    chemblControllerRef.current = controller;
    setChemblLoading(true);

    try {
      const response = await resolveChemblMoleculeByInchiKey(selected.inchiKey, {
        signal: controller.signal,
        input: selected.input,
        inputType: selected.inputType,
        formula: selected.formula,
        molecularWeight: selected.molecularWeight,
        connectivitySmiles: selected.connectivitySmiles
      });
      if (!controller.signal.aborted) {
        setChemblResult(response);
        // Exact identity may be carried forward automatically. Non-exact
        // cross-database candidates require an explicit user selection.
        if (response.matchType === "exact-inchi-key" && response.molecules.length === 1) {
          setSelectedChemblId(response.molecules[0].chemblId);
        }
      }
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && !controller.signal.aborted) {
        setChemblError(requestError?.message || "An unexpected error occurred while contacting ChEMBL.");
      }
    } finally {
      if (!controller.signal.aborted) setChemblLoading(false);
      if (chemblControllerRef.current === controller) chemblControllerRef.current = null;
    }
  }

  function selectChemblMolecule(molecule) {
    activityControllerRef.current?.abort();
    proteinControllerRef.current?.abort();
    proteinControllerRef.current = null;
    setProteinResult(null);
    setProteinError("");
    setProteinProgress(null);
    setProteinLoading(false);
    activityControllerRef.current = null;
    setSelectedChemblId(molecule?.chemblId || null);
    setActivityResult(null);
    setActivityError("");
    setActivityProgress(null);
    setActivityLoading(false);
  }

  async function loadPfProteinTargets() {
    if (!selectedChemblId) {
      setProteinError("Select an exact ChEMBL molecule record before searching for malaria proteins.");
      return;
    }
    proteinControllerRef.current?.abort();
    const controller = new AbortController();
    proteinControllerRef.current = controller;
    setProteinLoading(true);
    setProteinError("");
    setProteinResult(null);
    setProteinProgress({ pageCount: 0, retrievedCount: 0, totalCount: null });
    try {
      const response = await retrievePfProteinTargets(selectedChemblId, {
        signal: controller.signal,
        forceRefresh: Boolean(proteinResult),
        onProgress: progress => {
          if (!controller.signal.aborted) setProteinProgress(progress);
        }
      });
      if (!controller.signal.aborted) setProteinResult(response);
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && !controller.signal.aborted) {
        setProteinError(requestError?.message || "An unexpected error occurred while identifying malaria proteins.");
      }
    } finally {
      if (!controller.signal.aborted) setProteinLoading(false);
      if (proteinControllerRef.current === controller) proteinControllerRef.current = null;
    }
  }

  async function loadChemblActivities() {
    if (!selectedChemblId) {
      setActivityError("Select an exact ChEMBL molecule record before retrieving activity data.");
      return;
    }

    activityControllerRef.current?.abort();
    const controller = new AbortController();
    activityControllerRef.current = controller;
    const forceRefresh = Boolean(activityResult);
    setActivityLoading(true);
    setActivityError("");
    setActivityResult(null);
    setActivityProgress({ pageCount: 0, retrievedCount: 0, totalCount: null });

    try {
      const response = await retrieveChemblActivities(selectedChemblId, {
        signal: controller.signal,
        onProgress: progress => {
          if (!controller.signal.aborted) setActivityProgress(progress);
        },
        forceRefresh
      });
      if (!controller.signal.aborted) setActivityResult(response);
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && !controller.signal.aborted) {
        setActivityError(requestError?.message || "An unexpected error occurred while retrieving ChEMBL activities.");
      }
    } finally {
      if (!controller.signal.aborted) setActivityLoading(false);
      if (activityControllerRef.current === controller) activityControllerRef.current = null;
    }
  }

  function clearSearch() {
    activeController?.abort();
    chemblControllerRef.current?.abort();
    activityControllerRef.current?.abort();
    proteinControllerRef.current?.abort();
    chemblControllerRef.current = null;
    activityControllerRef.current = null;
    proteinControllerRef.current = null;
    setProteinResult(null);
    setProteinError("");
    setProteinProgress(null);
    setProteinLoading(false);
    setActivityResult(null);
    setActivityError("");
    setActivityProgress(null);
    setActivityLoading(false);
    setActiveController(null);
    setQuery("");
    setResult(null);
    setMatches([]);
    setMatchInfo(null);
    setChemblResult(null);
    setChemblError("");
    setChemblLoading(false);
    setSelectedChemblId(null);
    setError("");
    setLoading(false);
  }

  function scrollTo(id) {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="app">
      <header className="navbar">
        <div className="nav-inner">
          <a className="brand" href="#home" onClick={() => setMobileOpen(false)}>
            <div className="brand-icon"><Microscope size={23} /></div>
            <div>
              <div className="brand-name">WebServer<span>_MDT</span></div>
              <div className="brand-sub">MALARIA DRUG TARGET DISCOVERY</div>
            </div>
          </a>

          <nav className={mobileOpen ? "nav-links open" : "nav-links"}>
            <a href="#home" onClick={() => setMobileOpen(false)}>Home</a>
            <a href="#search" onClick={() => setMobileOpen(false)}>Compound Search</a>
            <a href="#databases" onClick={() => setMobileOpen(false)}>Databases</a>
            <a href="#workflow" onClick={() => setMobileOpen(false)}>Workflow</a>
            <a href="#about" onClick={() => setMobileOpen(false)}>About</a>
          </nav>

          <button className="nav-cta" onClick={() => scrollTo("search")}>
            Explore compounds <ArrowUpRight size={15} />
          </button>

          <button className="mobile-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation">
            {mobileOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>

      <main>
        <section className="hero" id="home">
          <div className="hero-grid">
            <div className="hero-content">
              <div className="eyebrow">
                <span className="status-dot"></span>
                BIOINFORMATICS RESEARCH PLATFORM
              </div>

              <h1>
                Discover the<br />
                <span>connections</span><br />
                behind drug targets.
              </h1>

              <p className="hero-description">
                An integrated research platform connecting chemical
                compound information with malaria parasite bioactivity
                evidence to support drug-target exploration.
              </p>

              <div className="hero-actions">
                <button className="primary-btn" onClick={() => scrollTo("search")}>
                  Start exploring <ArrowRight size={17} />
                </button>
                <button className="secondary-btn" onClick={() => scrollTo("workflow")}>
                  Explore workflow <ChevronRight size={17} />
                </button>
              </div>

              <div className="hero-meta">
                <span><ShieldCheck size={15} /> Research-oriented platform</span>
                <span><Activity size={15} /> Phase I prototype</span>
              </div>
            </div>

            <div className="hero-visual">
              <div className="visual-glow"></div>
              <div className="molecule-card">
                <div className="visual-top">
                  <span>RESEARCH OVERVIEW</span>
                  <span className="live-label"><span></span> PROTOTYPE</span>
                </div>
                <div className="molecule-art">
                  <svg viewBox="0 0 440 280" role="img" aria-label="Illustrative molecular network">
                    <g stroke="#5CB9A6" strokeWidth="2.2" fill="none" opacity=".7">
                      <path d="M110 92 L175 55 L240 90 L305 55 L365 100"/>
                      <path d="M110 92 L110 165 L175 202 L240 165 L305 202 L365 165"/>
                      <path d="M175 55 L175 202 M240 90 L240 165 M305 55 L305 202"/>
                      <path d="M110 165 L45 202 M365 100 L405 55"/>
                    </g>
                    <g fill="#0F8F7B">
                      <circle cx="110" cy="92" r="10"/><circle cx="175" cy="55" r="9"/>
                      <circle cx="240" cy="90" r="12"/><circle cx="305" cy="55" r="9"/>
                      <circle cx="365" cy="100" r="11"/><circle cx="110" cy="165" r="8"/>
                      <circle cx="175" cy="202" r="11"/><circle cx="240" cy="165" r="10"/>
                      <circle cx="305" cy="202" r="9"/><circle cx="365" cy="165" r="12"/>
                      <circle cx="45" cy="202" r="6"/><circle cx="405" cy="55" r="6"/>
                    </g>
                    <g fill="#A3DED0" opacity=".65">
                      <circle cx="240" cy="90" r="22"/><circle cx="365" cy="165" r="22"/>
                      <circle cx="175" cy="202" r="18"/>
                    </g>
                  </svg>
                </div>
                <div className="visual-caption">
                  <div className="visual-caption-icon"><Atom size={21}/></div>
                  <div>
                    <strong>Compound-to-target exploration</strong>
                    <span>Connecting chemical and biological information</span>
                  </div>
                </div>
                <div className="visual-bottom">
                  <span>CHEMINFORMATICS</span><span>MOLECULAR BIOLOGY</span><span>BIOINFORMATICS</span>
                </div>
              </div>
              <div className="floating-tag tag-one"><Database size={15}/> Chemical databases</div>
              <div className="floating-tag tag-two"><Dna size={15}/> Protein information</div>
            </div>
          </div>
          <div className="hero-bottom">
            <span>01 — COMPOUND IDENTIFICATION</span>
            <span>02 — TARGET ASSOCIATION</span>
            <span>03 — MALARIA PROTEIN DISCOVERY</span>
          </div>
        </section>

        <section className="search-section section" id="search">
          <div className="section-heading">
            <div>
              <div className="eyebrow">COMPOUND EXPLORER</div>
              <h2>Start with a <span>compound.</span></h2>
              <p>Resolve a chemical identity against the live PubChem database.</p>
            </div>
            <div className="section-index">01 / SEARCH</div>
          </div>

          <div className="search-panel">
            <div className="search-panel-header">
              <div className="panel-heading">
                <div className="panel-icon"><Search size={20}/></div>
                <div><strong>Compound search</strong><span>Live compound identification</span></div>
              </div>
              <span className="demo-chip">LIVE PUBCHEM API</span>
            </div>

            <div className="search-tabs" role="tablist" aria-label="Compound input type">
              {["Name", "PubChem CID", "SMILES"].map(type => (
                <button
                  key={type}
                  type="button"
                  role="tab"
                  aria-selected={searchType === type}
                  className={searchType === type ? "search-tab active" : "search-tab"}
                  onClick={() => { setSearchType(type); setError(""); }}
                >
                  {type}
                </button>
              ))}
            </div>

            <form className="search-form" onSubmit={event => { event.preventDefault(); searchCompound(); }}>
              <div className="search-input-wrap">
                <Search size={19}/>
                <input
                  value={query}
                  onChange={event => { setQuery(event.target.value); setError(""); }}
                  placeholder={
                    searchType === "Name" ? "e.g. Chloroquine, Artemisinin..." :
                    searchType === "PubChem CID" ? "e.g. 2719" :
                    "Enter a SMILES string..."
                  }
                  aria-label={`${searchType} input`}
                  autoComplete="off"
                />
                {query && <button type="button" className="clear-btn" onClick={clearSearch}>Clear</button>}
              </div>
              <button className="primary-btn search-button" type="submit" disabled={loading}>
                {loading ? "Searching PubChem..." : "Identify compound"}
                {!loading && <ArrowRight size={17}/>}
              </button>
            </form>

            <div className="search-help">
              <span><CircleHelp size={14}/> Test with a known compound:</span>
              {suggestedCompounds.map(compound => (
                <button type="button" key={compound} onClick={() => searchCompound(compound, "Name")}>
                  {compound}
                </button>
              ))}
            </div>

            <div className="stage-note">
              <strong>Current development stage:</strong> Live compound matching followed by focused Plasmodium falciparum protein-target discovery and UniProt sequence retrieval. Broad all-species activity data is supplementary evidence only.
            </div>

            {loading && (
              <div className="loading-message" role="status">
                <span className="loading-spinner" /> Resolving the compound and retrieving PubChem properties...
              </div>
            )}
            {error && <div className="error-message" role="alert">{error}</div>}
          </div>
        </section>

        {matches.length > 0 && matchInfo && (
          <section className="results-section section" id="results">
            <div className="section-heading">
              <div>
                <div className="eyebrow">COMPOUND MATCHES</div>
                <h2>Choose the <span>right record.</span></h2>
                <p>PubChem returned more than one compound for this input. Select the exact chemical record you intended.</p>
              </div>
              <span className="demo-chip">{matchInfo.totalMatches} MATCHES</span>
            </div>
            {matchInfo.truncated && <p className="stage-note">PubChem returned {matchInfo.totalMatches} matches. The first {matches.length} records are shown here.</p>}
            <div className="match-list">
              {matches.map(compound => (
                <article className="match-card" key={compound.cid}>
                  <div className="target-info">
                    <strong>{compound.title || compound.iupacName || `PubChem compound ${compound.cid}`}</strong>
                    <span>PubChem CID: {compound.cid}</span>
                    <small>{compound.formula || "Formula unavailable"} · {compound.molecularWeight ?? "Weight unavailable"} {compound.molecularWeight !== null ? "g/mol" : ""}</small>
                    <small>InChIKey: {compound.inchiKey || "Not provided"}</small>
                  </div>
                  <button type="button" className="secondary-btn choose-btn" onClick={() => chooseCompound(compound)}>
                    Choose this record <ArrowRight size={15}/>
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {result && (
          <section className="results-section section" id="results">
            <div className="section-heading">
              <div>
                <div className="eyebrow">STAGE 1 OUTPUT</div>
                <h2>Compound <span>identified.</span></h2>
                <p>Properties below are returned by PubChem for the selected compound record.</p>
              </div>
              <span className="demo-chip">LIVE DATABASE RESULT</span>
            </div>

            <div className="compound-result-card">
              <div className="compound-main">
                <div className="compound-symbol"><FlaskConical size={27}/></div>
                <div>
                  <span className="result-label">PUBCHEM COMPOUND RECORD</span>
                  <h3>{result.title || result.iupacName || `PubChem compound ${result.cid}`}</h3>
                  <span className="compound-cid">PubChem CID: {result.cid}</span>
                  <div style={{ marginTop: "8px" }}>
                    <a href={result.sourceUrl} target="_blank" rel="noreferrer">
                      View original PubChem record <ExternalLink size={13}/>
                    </a>
                  </div>
                </div>
              </div>
              <div className="compound-properties">
                <div><span>MOLECULAR FORMULA</span><strong>{result.formula || "Not provided by PubChem"}</strong></div>
                <div><span>MOLECULAR WEIGHT</span><strong>{result.molecularWeight !== null ? `${result.molecularWeight} g/mol` : "Not provided by PubChem"}</strong></div>
              </div>
            </div>

            <div className="compound-properties compound-properties-stack" style={{ marginTop: "12px" }}>
              <div><span>IUPAC NAME</span><strong>{result.iupacName || "Not provided by PubChem"}</strong></div>
              <div><span>CONNECTIVITY SMILES</span><strong className="chem-string">{result.connectivitySmiles || "Not provided by PubChem"}</strong></div>
              <div><span>SMILES</span><strong className="chem-string">{result.smiles || "Not provided by PubChem"}</strong></div>
              <div><span>INCHIKEY</span><strong className="chem-string">{result.inchiKey || "Not provided by PubChem"}</strong></div>
            </div>

            <div className="result-metadata">
              <span>Source: {result.source}</span>
              <span>Retrieved: {new Date(result.retrievedAt).toLocaleString()}</span>
            </div>

            <div className="chembl-stage-card">
              <div className="chembl-stage-heading">
                <div>
                  <span className="result-label">STAGE 2 OUTPUT</span>
                  <h3>ChEMBL molecule matching</h3>
                  <p>Strict full-InChIKey matching first, followed by clearly labelled cross-database candidate checks when the key differs.</p>
                </div>
                <span className="demo-chip">LIVE CHEMBL API</span>
              </div>

              <div className="chembl-key-row">
                <span>QUERY InChIKey</span>
                <code>{result.inchiKey || "Unavailable"}</code>
              </div>

              {chemblLoading && (
                <div className="loading-message" role="status">
                  <span className="loading-spinner" /> Checking ChEMBL for an exact structure match; if needed, checking a descriptor-verified name candidate...
                </div>
              )}

              {chemblError && <div className="error-message" role="alert">{chemblError}</div>}

              {chemblResult && (
                <>
                  {chemblResult.molecules.length === 0 ? (
                    <div className="chembl-empty-state">
                      <strong>No ChEMBL molecule could be confirmed by the available matching methods.</strong>
                      <p>No exact full-InChIKey record or descriptor-compatible name candidate was returned. A name-fragment candidate is only offered when formula and molecular weight agree; a different full InChIKey is always shown for review. Similarity alone is never treated as identity.</p>
                    </div>
                  ) : (
                    <div className="chembl-molecule-list">
                      {chemblResult.matchType !== "exact-inchi-key" && (
                        <p className="chembl-match-note">{chemblResult.matchLabel}. Review the ChEMBL structure and record before selecting this candidate; it is not an exact full-InChIKey match.</p>
                      )}
                      {chemblResult.molecules.length > 1 && (
                        <p className="chembl-match-note">ChEMBL returned multiple candidates. Select the intended molecule record to carry forward.</p>
                      )}
                      {chemblResult.molecules.map(molecule => (
                        <article className={`chembl-molecule-card ${selectedChemblId === molecule.chemblId ? "selected" : ""}`} key={molecule.chemblId}>
                          <div className="target-info">
                            <strong>{molecule.preferredName || "Unnamed ChEMBL molecule"}</strong>
                            <span>{molecule.chemblId}</span>
                            <small>Type: {molecule.moleculeType || "Not specified by ChEMBL"} · Max phase: {molecule.maxPhase ?? "Not reported"}</small>
                            {molecule.molecularFormula && <small>Formula: {molecule.molecularFormula}</small>}
                            {molecule.molecularWeight !== null && molecule.molecularWeight !== undefined && <small>Molecular weight: {Number(molecule.molecularWeight).toFixed(2)} g/mol</small>}
                            <small>ChEMBL InChIKey: {molecule.standardInchiKey || "Not supplied"}</small>
                            {chemblResult.matchType !== "exact-inchi-key" && <small className="candidate-match-type">{molecule.matchLabel}</small>}
                            <a href={molecule.recordUrl} target="_blank" rel="noreferrer">Open ChEMBL record <ExternalLink size={12}/></a>
                          </div>
                          <button type="button" className={selectedChemblId === molecule.chemblId ? "secondary-btn chosen-chembl-btn" : "secondary-btn choose-btn"} onClick={() => selectChemblMolecule(molecule)}>
                            {selectedChemblId === molecule.chemblId ? "Selected" : "Select molecule"}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  <div className="result-metadata">
                    <span>Source: ChEMBL Data Web Services</span>
                    <span>{chemblResult.matchType === "exact-inchi-key" ? "Exact full-InChIKey records" : "Cross-reference candidates"}: {chemblResult.molecules.length}{chemblResult.totalCount !== null ? ` / ${chemblResult.totalCount}` : ""}</span>
                    <span>Match method: {chemblResult.matchLabel || "No confirmed match"}</span>
                    <span>Release: {chemblResult.status.release || "Unavailable"}{chemblResult.status.releaseDate ? ` (${chemblResult.status.releaseDate})` : ""}</span>
                    <span>Retrieved: {new Date(chemblResult.retrievedAt).toLocaleString()}</span>
                    <a href={chemblResult.searchUrl} target="_blank" rel="noreferrer">Open API response <ExternalLink size={12}/></a>
                  </div>
                  {chemblResult.statusWarning && <p className="stage-note">{chemblResult.statusWarning}</p>}
                  {chemblResult.exactLookupWarning && <p className="stage-note">Exact InChIKey lookup note: {chemblResult.exactLookupWarning} Any displayed candidate was obtained through a separate non-exact fallback and must be reviewed.</p>}
                  {chemblResult.fallbackWarning && <p className="stage-note">{chemblResult.fallbackWarning}</p>}
                </>
              )}
            </div>

            <div className="protein-stage-card">
              <div className="chembl-stage-heading">
                <div>
                  <span className="result-label">STAGE 3 — CORE OUTPUT</span>
                  <h3>Malaria protein-target discovery</h3>
                  <p>Search only ChEMBL records associated with <em>Plasmodium falciparum</em>, classify the linked target entities, and retrieve UniProt accessions and protein sequences for single-protein targets.</p>
                </div>
                <span className="demo-chip">LIVE CHEMBL + UNIPROT</span>
              </div>
              <div className="activity-query-row">
                <span>SELECTED MOLECULE</span>
                <code>{selectedChemblId || "Choose a ChEMBL molecule above"}</code>
              </div>
              {selectedChemblId && chemblResult?.matchType && chemblResult.matchType !== "exact-inchi-key" && (
                <p className="stage-note">This molecule was selected from a non-exact ChEMBL cross-reference candidate ({chemblResult.matchLabel}). Review the ChEMBL record before interpreting target associations.</p>
              )}
              {selectedChemblId ? (
                <button type="button" className="primary-btn activity-fetch-btn" onClick={loadPfProteinTargets} disabled={proteinLoading}>
                  {proteinLoading ? "Finding malaria proteins..." : proteinResult ? "Refresh malaria protein results" : "Find Plasmodium falciparum proteins"}
                  {!proteinLoading && <ArrowRight size={16}/>}
                </button>
              ) : (
                <p className="stage-note">Select a ChEMBL molecule record above to enable protein discovery.</p>
              )}
              {proteinLoading && (
                <div className="loading-message" role="status">
                  <span className="loading-spinner" />
                  <span>
                    {proteinProgress?.phase === "malaria-evidence" && `Retrieving malaria-only ChEMBL evidence: ${proteinProgress?.retrievedCount ?? 0}${proteinProgress?.totalCount !== null && proteinProgress?.totalCount !== undefined ? ` of ${proteinProgress.totalCount}` : ""} records across ${proteinProgress?.pageCount ?? 0} page(s)${proteinProgress?.pageLimit ? ` (page size ${proteinProgress.pageLimit})` : ""}.`}
                    {proteinProgress?.phase === "local-filter-fallback" && `ChEMBL's species filter is unavailable. Retrieving records for this molecule only, then filtering locally: ${proteinProgress?.retrievedCount ?? 0}${proteinProgress?.totalCount !== null && proteinProgress?.totalCount !== undefined ? ` of ${proteinProgress.totalCount}` : ""}.`}
                    {proteinProgress?.phase === "mechanism" && "Checking ChEMBL's curated mechanism-of-action annotations."}
                    {proteinProgress?.phase === "target-metadata" && `Classifying ${proteinProgress?.targetCount ?? 0} linked ChEMBL target entities.`}
                    {proteinProgress?.phase === "uniprot" && `Retrieving UniProt protein entries and sequences: ${proteinProgress?.sequenceRetrievedCount ?? 0} of ${proteinProgress?.sequenceTotalCount ?? 0}.`}
                    {proteinProgress?.phase === "uniprot-name-fallback" && `Checking UniProtKB for exact protein-name matches in P. falciparum: ${proteinProgress?.sequenceRetrievedCount ?? 0} of ${proteinProgress?.sequenceTotalCount ?? 0}.`}
                    {!proteinProgress?.phase && "Starting malaria-specific protein discovery."}
                  </span>
                </div>
              )}
              {proteinError && <div className="error-message" role="alert">{proteinError}</div>}
              {proteinResult && (
                <>
                  <div className="activity-summary-grid protein-summary-grid">
                    <div><span>P. FALCIPARUM RECORDS</span><strong>{proteinResult.malariaActivityRetrieved.toLocaleString()}</strong></div>
                    <div><span>P. FALCIPARUM TARGET ENTITIES</span><strong>{proteinResult.targetCount.toLocaleString()}</strong></div>
                    <div><span>CURATED MOA ANNOTATIONS</span><strong>{proteinResult.mechanismStatus === "unavailable" ? "Unavailable" : proteinResult.mechanismStatus === "partial" ? `${proteinResult.mechanismCount} · partial` : proteinResult.mechanismCount.toLocaleString()}</strong></div>
                    <div><span>ChEMBL-VERIFIED SINGLE PROTEINS</span><strong>{proteinResult.proteins.length.toLocaleString()}</strong></div>
                    <div><span>UNIPROT NAME-MATCHED LEADS</span><strong>{(proteinResult.uniprotNameCandidates || []).length.toLocaleString()}</strong></div>
                    <div><span>UNIPROT SEQUENCES</span><strong>{proteinResult.sequenceCount.toLocaleString()}</strong></div>
                  </div>
                  {proteinResult.activityComplete === false && (
                    <div className="error-message" role="status">
                      <strong>Partial ChEMBL evidence — not a complete result.</strong>
                      <p>Retrieved {proteinResult.malariaActivityRetrieved} of {proteinResult.malariaActivityTotal ?? "an unknown number of"} malaria activity records. Failed page offsets: {(proteinResult.activityMissingOffsets || []).join(", ") || "not confirmed"}. Successfully retrieved records and their protein associations are retained below as preliminary evidence; missing pages may contain additional targets. Retry later to complete the search.</p>
                    </div>
                  )}
                  {proteinResult.activityQueryWarning && <p className="stage-note">Activity retrieval note: {proteinResult.activityQueryWarning} {proteinResult.localFallbackStats ? `Scanned ${proteinResult.localFallbackStats.compoundActivityCount.toLocaleString()} compound-specific records across ${proteinResult.localFallbackStats.compoundActivityPages} pages; retained ${proteinResult.localFallbackStats.malariaActivityCount.toLocaleString()} malaria-associated record(s).` : ""}</p>}
                  {proteinResult.proteins.length > 0 && (
                    <div className="protein-candidate-list">
                      <div className="activity-groups-header">
                        <strong>ChEMBL-classified single-protein targets</strong>
                        <span>Target type and UniProt component were supplied by ChEMBL.</span>
                      </div>
                      {[...proteinResult.proteins].sort((a, b) => (b.mechanismCount - a.mechanismCount) || (b.activityCount - a.activityCount)).map(protein => (
                        <ProteinCandidateCard key={protein.chemblId} protein={protein} mechanismStatus={proteinResult.mechanismStatus}/>
                      ))}
                    </div>
                  )}
                  {(proteinResult.uniprotNameCandidates || []).length > 0 && (
                    <div className="protein-candidate-list">
                      <div className="activity-groups-header">
                        <strong>UniProtKB name-matched protein leads</strong>
                        <span>Exact normalized protein-name matches restricted to P. falciparum (taxon 5833) and its 3D7 isolate (taxon 36329). These are provisional because ChEMBL target type/component metadata was unavailable.</span>
                      </div>
                      {[...proteinResult.uniprotNameCandidates].sort((a, b) => (b.activityCount - a.activityCount)).map(protein => (
                        <ProteinCandidateCard key={`${protein.chemblId}-${protein.accession}`} protein={protein} mechanismStatus={proteinResult.mechanismStatus}/>
                      ))}
                    </div>
                  )}
                  {proteinResult.proteins.length === 0 && (proteinResult.uniprotNameCandidates || []).length === 0 && (
                    <div className="chembl-empty-state">
                      <strong>{proteinResult.unclassifiedTargets?.length || proteinResult.targetLookupWarnings?.length ? "Protein-target classification is incomplete." : "No single-protein target was identified in the retrieved evidence."}</strong>
                      <p>ChEMBL returned {proteinResult.malariaActivityRetrieved} <em>P. falciparum</em>-associated record(s) across {proteinResult.targetCount} target entity/entities, but the available records did not produce a verifiable single-protein target or an exact UniProtKB name match. This is not evidence that no protein target exists.</p>
                    </div>
                  )}
                  <div className="result-metadata">
                    <span>Source: {proteinResult.source}</span>
                    <span>Retrieved: {new Date(proteinResult.retrievedAt).toLocaleString()}</span>
                    <a href={proteinResult.mechanismSearchUrl} target="_blank" rel="noreferrer">Open ChEMBL mechanism query <ExternalLink size={12}/></a>
                  <a href={proteinResult.activitySearchUrl} target="_blank" rel="noreferrer">{proteinResult.activityFilterMode === "local-filter" ? "Open selected-molecule activity query (locally filtered)" : proteinResult.activityFilterMode === "tax-id" ? "Open taxonomy-filtered malaria evidence query" : "Open malaria-filtered evidence query"} <ExternalLink size={12}/></a>
                  </div>
                  {proteinResult.mechanismWarning && <p className="stage-note">Curated mechanism lookup is {proteinResult.mechanismStatus === "unavailable" ? "unavailable (the count is not a confirmed zero)" : "partial"}: {proteinResult.mechanismWarning}</p>}
                  {proteinResult.targetLookupFallbacks?.length > 0 && <p className="stage-note">ChEMBL target metadata was recovered through an alternate exact-ID collection lookup for {proteinResult.targetLookupFallbacks.length} target(s).</p>}
                  {proteinResult.targetLookupWarnings?.length > 0 && <p className="stage-note">ChEMBL target metadata could not be retrieved for {proteinResult.targetLookupWarnings.length} target ID(s). Exact UniProtKB protein-name matches, where found, are listed separately as provisional leads and are not counted as ChEMBL-verified single-protein targets.</p>}
                  {(proteinResult.excludedTargets || []).length > 0 && (
                    <details className="excluded-targets">
                      <summary>ChEMBL entities classified as non-single-protein targets ({proteinResult.excludedTargets.length})</summary>
                      <ul>
                        {proteinResult.excludedTargets.map(target => (
                          <li key={target.chemblId}><strong>{target.name || "Target name not supplied"}</strong> — {target.chemblId}; {target.targetType}; {target.organism || "organism unavailable"}; {target.activityCount} record(s). {target.exclusionReason}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {proteinResult.unclassifiedTargets.length > 0 && (
                    <details className="excluded-targets">
                      <summary>ChEMBL target entities awaiting metadata classification ({proteinResult.unclassifiedTargets.length})</summary>
                      <ul>
                        {proteinResult.unclassifiedTargets.map(target => (
                          <li key={target.chemblId}><strong>{target.name || "Target name not supplied"}</strong> — {target.chemblId}; {target.targetType || "target type unavailable"}; {target.organism || "organism unavailable"}; {target.activityCount} record(s). Metadata source: {target.metadataSource}.</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {(proteinResult.uniprotNameSearchWarnings || []).length > 0 && <p className="stage-note">UniProtKB name search could not classify {proteinResult.uniprotNameSearchWarnings.length} target name(s); those targets remain unclassified. {proteinResult.uniprotNameSearchWarnings.map(item => `${item.targetName}: ${item.message}`).join(" ")}</p>}
                  {proteinResult.sequenceErrors.length > 0 && <p className="stage-note">{proteinResult.sequenceErrors.length} UniProt accession lookup(s) did not return a sequence; affected candidates remain visible with their error details.</p>}
                  <p className="stage-note">A ChEMBL single-protein association is database evidence, not proof of direct drug binding or clinical target validation. Species-level matches are not automatically confirmed as the P. falciparum 3D7 strain.</p>
                </>
              )}
            </div>

            <details className="optional-activity-audit">
              <summary>Optional supplementary evidence audit: inspect all ChEMBL activity records across organisms</summary>
              <div className="optional-activity-audit-content">
            <div className="activity-stage-card">
              <div className="chembl-stage-heading">
                <div>
                  <span className="result-label">STAGE 3 OUTPUT</span>
                  <h3>Broad activity evidence audit</h3>
                  <p>Optional: inspect all organism-level and non-malaria ChEMBL activity records for context. This is not the protein-discovery output.</p>
                </div>
                <span className="demo-chip">LIVE ACTIVITY API</span>
              </div>

              <div className="activity-query-row">
                <span>SELECTED MOLECULE</span>
                <code>{selectedChemblId || "Choose a ChEMBL molecule above"}</code>
              </div>
              {selectedChemblId && chemblResult?.matchType && chemblResult.matchType !== "exact-inchi-key" && (
                <p className="stage-note">This molecule was selected from a non-exact ChEMBL cross-reference candidate ({chemblResult.matchLabel}). Review the ChEMBL record before interpreting target associations.</p>
              )}

              {selectedChemblId ? (
                <button type="button" className="primary-btn activity-fetch-btn" onClick={loadChemblActivities} disabled={activityLoading}>
                  {activityLoading ? "Retrieving activity pages..." : activityResult ? "Refresh activity records" : "Retrieve all activity records"}
                  {!activityLoading && <ArrowRight size={16}/>}
                </button>
              ) : (
                <p className="stage-note">Select an exact ChEMBL molecule record above to enable activity retrieval.</p>
              )}

              {activityLoading && (
                <div className="loading-message" role="status">
                  <span className="loading-spinner" />
                  <span>
                    Retrieving ChEMBL activity records: {activityProgress?.retrievedCount ?? 0}{activityProgress?.totalCount !== null && activityProgress?.totalCount !== undefined ? ` of ${activityProgress.totalCount}` : ""} records across {activityProgress?.pageCount ?? 0} completed page(s)
                    {activityProgress?.totalCount > 0 ? ` (${Math.min(100, Math.floor((activityProgress.retrievedCount / activityProgress.totalCount) * 100))}%)` : ""}.
                    Using 500-record pages with up to 3 requests at a time.
                  </span>
                </div>
              )}

              {activityError && (
                <div className="activity-error-block">
                  <div className="error-message" role="alert">{activityError}</div>
                  {activityProbeUrl && (
                    <a className="activity-probe-link" href={activityProbeUrl} target="_blank" rel="noreferrer">
                      Open one-record raw ChEMBL response <ExternalLink size={12}/>
                    </a>
                  )}
                </div>
              )}

              {activityResult && (
                <>
                  <div className="activity-summary-grid">
                    <div><span>CHembl total_count</span><strong>{activityResult.totalCount ?? "Not reported"}</strong></div>
                    <div><span>Records retrieved</span><strong>{activityResult.retrievedCount}</strong></div>
                    <div><span>Target groups</span><strong>{activityResult.groupCount}</strong></div>
                    <div><span>Pages retrieved</span><strong>{activityResult.pageCount}</strong></div>
                  </div>

                  {activityResult.countMatches === false && (
                    <div className="error-message" role="alert">
                      ChEMBL reported {activityResult.totalCount} records, but {activityResult.retrievedCount} were retrieved. These results are incomplete and must not be treated as a complete activity set. Try refreshing the retrieval.
                    </div>
                  )}
                  {activityResult.countMatches === null && (
                    <p className="stage-note">Pagination ended successfully, but ChEMBL did not include total_count in its response, so the retrieved row count could not be independently compared.</p>
                  )}

                  {activityResult.groups.length === 0 ? (
                    <div className="chembl-empty-state">
                      <strong>No activity records were returned for this molecule.</strong>
                      <p>ChEMBL returned an empty activity collection for this exact molecule ID. No target associations have been inferred.</p>
                    </div>
                  ) : (
                    <div className="activity-groups">
                      <div className="activity-groups-header">
                        <strong>Activity records grouped by target</strong>
                        <span>Groups are not a target-confidence ranking.</span>
                      </div>
                      {activityResult.groups.map(group => (
                        <ActivityTargetGroup group={group} key={group.key}/>
                      ))}
                    </div>
                  )}

                  <div className="result-metadata">
                    <span>Source: {activityResult.source}</span>
                    <span>Retrieved: {new Date(activityResult.retrievedAt).toLocaleString()}</span>
                    <a href={activityResult.searchUrl} target="_blank" rel="noreferrer">Open first-page API response <ExternalLink size={12}/></a>
                  </div>
                  {activityResult.complete && <p className="stage-note">All available pages were retrieved{activityResult.totalCount !== null ? ` and the retrieved count matches ChEMBL total_count (${activityResult.totalCount})` : ""}. Values are displayed as reported by ChEMBL.</p>}
                </>
              )}
            </div>
              </div>
            </details>

            <div className="result-disclaimer">
              <CircleHelp size={16}/>
              Database activity associations are evidence records, not experimentally validated drug targets. Organism-level and other non-protein target records are not presented as proteins.
            </div>
          </section>
        )}

        <section className="database-section section" id="databases">
          <div className="section-heading">
            <div>
              <div className="eyebrow">INTEGRATED RESOURCES</div>
              <h2>Connecting research <span>databases.</span></h2>
              <p>Bringing complementary biological and chemical resources into one workflow.</p>
            </div>
            <div className="section-index">02 / RESOURCES</div>
          </div>

          <div className="database-grid">
            {databases.map(db => {
              const Icon = db.icon;
              return (
                <article className="database-card" key={db.name}>
                  <div className="database-card-top"><div className="database-icon"><Icon size={22}/></div><ArrowUpRight size={17} className="external-icon"/></div>
                  <span className="database-tag">{db.tag}</span>
                  <h3>{db.name}</h3>
                  <p>{db.description}</p>
                  <div className="database-card-bottom"><span>{db.status}</span><span className="resource-dot"></span></div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="workflow-section section" id="workflow">
          <div className="section-heading">
            <div>
              <div className="eyebrow">HOW IT WORKS</div>
              <h2>A connected research <span>workflow.</span></h2>
              <p>From compound identification to candidate protein exploration.</p>
            </div>
            <div className="section-index">03 / WORKFLOW</div>
          </div>

          <div className="workflow-grid">
            {workflow.map((step, index) => {
              const Icon = step.icon;
              return (
                <article className="workflow-card" key={step.number}>
                  <div className="workflow-card-top"><span>{step.number}</span><Icon size={22}/></div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                  {index === 3 && <span className="future-label">PHASE II</span>}
                </article>
              );
            })}
          </div>
        </section>

        <section className="about-section section" id="about">
          <div className="about-box">
            <div className="about-content">
              <div className="eyebrow">ABOUT THE PROJECT</div>
              <h2>Making biological research workflows <span>more connected.</span></h2>
              <p>
                WebServer_MDT is a B.Tech project focused on developing an
                integrated web platform for compound-based exploration of
                potential drug targets in Plasmodium falciparum.
              </p>
              <div className="about-meta">
                <div><span>INSTITUTE</span><strong>Indian Institute of Technology Guwahati</strong></div>
                <div><span>DEPARTMENT</span><strong>Biosciences and Bioengineering</strong></div>
                <div><span>PROJECT STAGE</span><strong>Phase I – Website prototype</strong></div>
              </div>
            </div>
            <div className="about-art"><Microscope size={100} strokeWidth={0.8}/><div className="about-art-caption">BIOINFORMATICS<br/>RESEARCH & DISCOVERY</div></div>
          </div>
        </section>

        <section className="history-section section">
          <div className="history-heading"><div><Clock3 size={18}/><strong>Recent searches</strong></div><span>LOCAL SEARCH HISTORY</span></div>
          {history.length > 0 ? (
            <div className="history-items">{history.map(item => <button key={`${item.type}:${item.input}`} onClick={() => searchCompound(item.input, item.type)}><History size={15}/>{item.label}<ArrowUpRight size={14}/></button>)}</div>
          ) : <p className="empty-history">Your recent searches will appear here during this session.</p>}
        </section>
      </main>

      <footer className="footer">
        <div className="footer-main">
          <a className="brand footer-brand" href="#home">
            <div className="brand-icon"><Microscope size={22}/></div>
            <div><div className="brand-name">WebServer<span>_MDT</span></div><div className="brand-sub">MALARIA DRUG TARGET DISCOVERY</div></div>
          </a>
          <p>An integrated research platform for compound and protein target exploration.</p>
          <button className="back-top" onClick={() => scrollTo("home")}>Back to top ↑</button>
        </div>
        <div className="footer-bottom">
          <span>© 2026 WebServer_MDT · B.Tech Project Phase I</span>
          <span>Department of Biosciences and Bioengineering · IIT Guwahati</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
