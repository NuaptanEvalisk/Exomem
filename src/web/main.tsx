import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  App as AntApp,
  Alert,
  Button,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space as Inline,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import enUS from "antd/locale/en_US";
import {
  ArrowLeftOutlined,
  BookOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";

import type {
  Entry,
  EntryInput,
  Revision,
  SearchResult,
  Space,
  TokenInfo,
} from "../shared/schema";
import { api, download } from "./api";
import type { EditorHandle } from "./Editor";
import "./style.css";

dayjs.locale("en");
const Editor = lazy(() => import("./Editor"));
const { Text, Paragraph } = Typography;
type Page = "timeline" | "note" | "tokens" | "history" | "trash" | "settings";
const labels: Record<Page, string> = {
  timeline: "Timeline",
  note: "Notes",
  tokens: "Tokens",
  history: "History",
  trash: "Trash",
  settings: "Settings",
};
const descriptions: Record<Page, string> = {
  timeline: "Keep a record of what happened, and what it meant to you.",
  note: "A place for lasting thoughts. Organize them with titles and tags.",
  tokens:
    "Give token.txt to the ChatGPT conversations that belong in this space.",
  history: "Follow changes over time and bring back an earlier version.",
  trash: "Deleted memories stay here until you restore them.",
  settings: "Manage this space and take your memories with you.",
};
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateTime = (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm");
const entryLabel = (e: Entry) =>
  e.kind === "note"
    ? e.title
    : (e.content.split("\n").find(Boolean)?.slice(0, 90) ?? "Event");
const actionLabel: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Moved to trash",
  restore: "Restore",
  import: "Imported",
};
const newKey = () => crypto.randomUUID();

function Exomem() {
  const { message, modal } = AntApp.useApp();
  const [spaces, setSpaces] = useState<Space[]>([]),
    [spaceId, setSpaceId] = useState("");
  const [page, setPage] = useState<Page>("timeline");
  const [entries, setEntries] = useState<Entry[]>([]),
    [tokens, setTokens] = useState<TokenInfo[]>([]),
    [history, setHistory] = useState<Revision[]>([]);
  const [tags, setTags] = useState<string[]>([]),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [tag, setTag] = useState<string>();
  const [dates, setDates] = useState<[Dayjs, Dayjs] | null>(null);
  const [cursor, setCursor] = useState<string>(),
    [next, setNext] = useState<string | null>(null),
    [back, setBack] = useState<(string | undefined)[]>([]),
    [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [spaceModal, setSpaceModal] = useState(false),
    [spaceForm] = Form.useForm();
  const [editing, setEditing] = useState<Entry | "new" | null>(null),
    [entryForm] = Form.useForm();
  const [content, setContent] = useState(""),
    [initialContent, setInitialContent] = useState(""),
    [dirty, setDirty] = useState(false),
    [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState("");
  const editKey = useRef<string>(newKey());
  const editorRef = useRef<EditorHandle>(null);
  const lastPayload = useRef("");
  const [tokenModal, setTokenModal] = useState(false),
    [tokenForm] = Form.useForm(),
    [newToken, setNewToken] = useState<{ token: string; name: string } | null>(
      null,
    );
  const [inspecting, setInspecting] = useState<Entry | null>(null),
    [versions, setVersions] = useState<Revision[]>([]),
    [selectedVersion, setSelectedVersion] = useState<Revision | null>(null);
  const [settingsForm] = Form.useForm();
  const space = spaces.find((s) => s.id === spaceId);
  const kind =
    typeof editing === "object" && editing
      ? editing.kind
      : page === "timeline"
        ? "timeline"
        : "note";
  const timeKind = Form.useWatch("timeKind", entryForm) ?? "date";
  const reload = () => setRefresh((v) => v + 1);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    setCursor(undefined);
    setBack([]);
  }, [query, tag, dates, page, spaceId]);
  useEffect(() => {
    const controller = new AbortController();
    api<Space[]>("/spaces", "GET", undefined, controller.signal)
      .then((data) => {
        setSpaces(data);
        setSpaceId((current) =>
          data.some((s) => s.id === current) ? current : (data[0]?.id ?? ""),
        );
        if (!data.length) setLoading(false);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!spaceId) return;
    const controller = new AbortController(),
      signal = controller.signal;
    setLoading(true);
    setError("");
    const base = `/spaces/${spaceId}`;
    const params = new URLSearchParams({
      limit: "30",
      q: query,
      deleted: page === "trash" ? "deleted" : "active",
    });
    if (page === "timeline" || page === "note") params.set("kind", page);
    if (cursor) params.set("cursor", cursor);
    if (tag && page === "note") params.set("tag", tag);
    if (dates && page === "timeline") {
      params.set("dateFrom", dates[0].format("YYYY-MM-DD"));
      params.set("dateTo", dates[1].format("YYYY-MM-DD"));
      params.set("instantFrom", dates[0].startOf("day").toISOString());
      params.set("instantTo", dates[1].endOf("day").toISOString());
    }
    const run = async () => {
      if (page === "tokens")
        setTokens(
          await api<TokenInfo[]>(`${base}/tokens`, "GET", undefined, signal),
        );
      else if (page === "history")
        setHistory(
          await api<Revision[]>(`${base}/history`, "GET", undefined, signal),
        );
      else if (page !== "settings") {
        const result = await api<SearchResult>(
          `${base}/entries?${params}`,
          "GET",
          undefined,
          signal,
        );
        setEntries(result.items);
        setTotal(result.total);
        setNext(result.nextCursor);
      }
      setTags(await api<string[]>(`${base}/tags`, "GET", undefined, signal));
    };
    void run()
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [spaceId, page, query, tag, dates, cursor, refresh]);
  useEffect(() => {
    if (space)
      settingsForm.setFieldsValue({
        name: space.name,
        description: space.description,
      });
  }, [space, settingsForm]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const perform = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) message.success(success);
      reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  function edit(entry: Entry | "new") {
    setEditing(entry);
    setDirty(false);
    setSaveError("");
    setReady(false);
    editKey.current = newKey();
    lastPayload.current = "";
    const source = entry === "new" ? "" : entry.content;
    setContent(source);
    setInitialContent(source);
    entryForm.resetFields();
    entryForm.setFieldsValue(
      entry === "new"
        ? {
            title: "",
            tags: [],
            timeKind: "date",
            date: dayjs(),
            instant: dayjs(),
          }
        : {
            title: entry.title,
            tags: entry.tags,
            timeKind: entry.time?.kind ?? "date",
            date:
              entry.time?.kind === "date" ? dayjs(entry.time.date) : dayjs(),
            instant:
              entry.time?.kind === "instant" ? dayjs(entry.time.at) : dayjs(),
          },
    );
  }
  function closeEditor() {
    if (saving) return;
    if (dirty)
      modal.confirm({
        title: "Discard unsaved changes?",
        content: "Your changes will be lost if you close this editor.",
        okText: "Discard changes",
        cancelText: "Keep editing",
        onOk: () => {
          setEditing(null);
          setDirty(false);
        },
      });
    else setEditing(null);
  }
  async function saveEntry() {
    try {
      const values = await entryForm.validateFields();
      const currentContent = editorRef.current?.getMarkdown() ?? content;
      if (!currentContent.trim()) {
        setSaveError("Please add some content.");
        return;
      }
      setSaving(true);
      setSaveError("");
      const data: EntryInput =
        kind === "note"
          ? {
              kind,
              title: values.title,
              tags: values.tags ?? [],
              content: currentContent,
            }
          : {
              kind,
              content: currentContent,
              time:
                values.timeKind === "date"
                  ? { kind: "date", date: values.date.format("YYYY-MM-DD") }
                  : { kind: "instant", at: values.instant.toISOString() },
            };
      const payload = JSON.stringify(data);
      if (lastPayload.current && lastPayload.current !== payload)
        editKey.current = newKey();
      lastPayload.current = payload;
      const current = editing === "new" ? null : editing;
      await api(
        `/spaces/${spaceId}/entries${current ? `/${current.id}` : ""}`,
        current ? "PUT" : "POST",
        {
          requestId: editKey.current,
          expectedRevision: current?.revision,
          data,
        },
      );
      setEditing(null);
      setDirty(false);
      reload();
      message.success("Saved");
    } catch (e) {
      if (e instanceof Error) setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }
  async function openHistory(entry: Entry) {
    setInspecting(entry);
    setSelectedVersion(null);
    setVersions([]);
    try {
      const [current, revisions] = await Promise.all([
        api<Entry>(`/spaces/${spaceId}/entries/${entry.id}`),
        api<Revision[]>(`/spaces/${spaceId}/history?entryId=${entry.id}`),
      ]);
      setInspecting(current);
      setVersions(revisions);
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function restore(entry: Entry, targetRevision?: number) {
    await api(`/spaces/${spaceId}/entries/${entry.id}/restore`, "POST", {
      requestId: newKey(),
      expectedRevision: entry.revision,
      targetRevision,
    });
    setInspecting(null);
  }
  const remove = (entry: Entry) =>
    perform(
      () =>
        api(`/spaces/${spaceId}/entries/${entry.id}`, "DELETE", {
          requestId: newKey(),
          expectedRevision: entry.revision,
        }),
      "Moved to trash",
    );
  const entryActions = (entry: Entry) => (
    <Inline size={4}>
      {page === "trash" ? (
        <Button
          size="small"
          disabled={space?.archived}
          onClick={() => void perform(() => restore(entry), "Restored")}
        >
          Restore
        </Button>
      ) : (
        <Button
          type="text"
          aria-label="Edit"
          icon={<EditOutlined />}
          disabled={space?.archived}
          onClick={() => edit(entry)}
        />
      )}
      <Tooltip title="Version history">
        <Button
          type="text"
          aria-label="Version history"
          icon={<HistoryOutlined />}
          onClick={() => void openHistory(entry)}
        />
      </Tooltip>
      {page !== "trash" && (
        <Popconfirm
          title="Move to trash?"
          description="The content and its history can still be restored."
          onConfirm={() => remove(entry)}
        >
          <Button
            type="text"
            aria-label="Delete"
            danger
            disabled={space?.archived}
            icon={<DeleteOutlined />}
          />
        </Popconfirm>
      )}
    </Inline>
  );

  return (
    <Layout className="app-layout">
      <Layout.Sider
        width={232}
        className="sidebar"
        breakpoint="lg"
        collapsedWidth={64}
      >
        <div className="brand">
          <span className="brand-mark">
            e<span>·</span>
          </span>
          <div className="brand-name">
            Exomem<small>A lasting place for memory</small>
          </div>
        </div>
        <div className="space-switch">
          <span className="eyebrow">MEMORY SPACE</span>
          <Select
            aria-label="Select space"
            value={spaceId || undefined}
            placeholder="Select space"
            onChange={(v) => {
              setSpaceId(v);
              setQ("");
              setTag(undefined);
            }}
            options={spaces.map((s) => ({
              value: s.id,
              label: `${s.name}${s.archived ? " · Archived" : ""}`,
            }))}
          />
          <Button
            type="text"
            icon={<PlusOutlined />}
            onClick={() => {
              spaceForm.resetFields();
              setSpaceModal(true);
            }}
          >
            New space
          </Button>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => {
            setPage(e.key as Page);
            setQ("");
            setTag(undefined);
          }}
          items={[
            {
              key: "timeline",
              icon: <ClockCircleOutlined />,
              label: (
                <span>
                  Timeline <small>{space?.timeline ?? 0}</small>
                </span>
              ),
            },
            {
              key: "note",
              icon: <BookOutlined />,
              label: (
                <span>
                  Notes <small>{space?.notes ?? 0}</small>
                </span>
              ),
            },
            { type: "divider" },
            { key: "tokens", icon: <KeyOutlined />, label: "Tokens" },
            { key: "history", icon: <HistoryOutlined />, label: "History" },
            { key: "trash", icon: <DeleteOutlined />, label: "Trash" },
            { key: "settings", icon: <SettingOutlined />, label: "Settings" },
          ]}
        />
        <div className="sidebar-foot">
          <span className="status-dot" /> Self-hosted memory
          <small>EXOMEM / 0.1</small>
        </div>
      </Layout.Sider>
      <Layout className="main-layout">
        <header className="topbar">
          <span>
            {space?.name ?? "Your memory space"}{" "}
            <span className="slash">/</span> {labels[page]}
          </span>
          <span className="topbar-note">CONTINUITY, ACROSS CONVERSATIONS</span>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "timeline"
                  ? "A CONTINUOUS STORY"
                  : page === "note"
                    ? "THOUGHTS, KEPT CLOSE"
                    : "YOUR MEMORY, IN YOUR HANDS"}
              </span>
              <h1>{labels[page]}</h1>
              <p>{descriptions[page]}</p>
            </div>
            <Inline>
              <Tooltip title="Refresh">
                <Button
                  aria-label="Refresh"
                  icon={<ReloadOutlined />}
                  onClick={reload}
                />
              </Tooltip>
              {(page === "note" || page === "timeline") && space && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={space.archived}
                  onClick={() => edit("new")}
                >
                  {page === "note" ? "New note" : "Record event"}
                </Button>
              )}
              {page === "tokens" && space && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={space.archived}
                  onClick={() => {
                    tokenForm.resetFields();
                    setTokenModal(true);
                  }}
                >
                  New token
                </Button>
              )}
            </Inline>
          </div>
          {error && (
            <Alert
              className="section-gap"
              type="error"
              showIcon
              title="Unable to load"
              description={error}
              action={<Button onClick={reload}>Retry</Button>}
            />
          )}
          {space?.archived && (
            <Alert
              className="section-gap"
              showIcon
              type="warning"
              title="This space is archived"
              description="You can still view and export memories. Tokens cannot access this space until it is restored."
            />
          )}
          {!space && !loading ? (
            <div className="welcome-panel">
              <div className="welcome-number">01 / GET STARTED</div>
              <h2>Keep what matters.</h2>
              <p>
                Create a space for your timeline and notes.
                <br />
                Each space has its own memories and access tokens.
              </p>
              <Button
                type="primary"
                size="large"
                icon={<PlusOutlined />}
                onClick={() => setSpaceModal(true)}
              >
                Create your first space
              </Button>
            </div>
          ) : (
            <>
              {(page === "note" || page === "timeline" || page === "trash") && (
                <>
                  <div className="filterbar">
                    <Input.Search
                      allowClear
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search memories in any language…"
                      aria-label="Search memories"
                    />
                    {page === "note" && (
                      <Select
                        allowClear
                        placeholder="All tags"
                        aria-label="Filter tags"
                        value={tag}
                        onChange={setTag}
                        options={tags.map((value) => ({ value, label: value }))}
                      />
                    )}
                    {page === "timeline" && (
                      <DatePicker.RangePicker
                        value={dates}
                        onChange={(v) =>
                          setDates(v?.[0] && v[1] ? [v[0], v[1]] : null)
                        }
                      />
                    )}
                    <span className="result-count">
                      {total} {total === 1 ? "record" : "records"}
                    </span>
                  </div>
                  {page === "timeline" && (
                    <div className="time-caption">
                      Times shown in {localZone} · Date-only events keep their
                      original date
                    </div>
                  )}
                  <Table<Entry>
                    className="memory-table"
                    rowKey="id"
                    loading={loading}
                    dataSource={entries}
                    pagination={false}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={
                            query
                              ? "No matching memories. Try another keyword."
                              : page === "trash"
                                ? "The trash is empty."
                                : "No memories yet. Add your first one."
                          }
                        />
                      ),
                    }}
                    columns={[
                      ...(page === "timeline"
                        ? [
                            {
                              title: "Occurred",
                              key: "time",
                              width: 190,
                              render: (_: unknown, e: Entry) => (
                                <div className="event-time">
                                  {e.time?.kind === "date" ? (
                                    <>
                                      <strong>{e.time.date}</strong>
                                      <small>Date only</small>
                                    </>
                                  ) : e.time?.kind === "instant" ? (
                                    <>
                                      <strong>
                                        {dayjs(e.time.at).format("YYYY-MM-DD")}
                                      </strong>
                                      <Tooltip title={e.time.at}>
                                        <small>
                                          {dayjs(e.time.at).format("HH:mm:ss")}{" "}
                                          · local time
                                        </small>
                                      </Tooltip>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              ),
                            },
                          ]
                        : []),
                      {
                        title: page === "timeline" ? "Event" : "Memory",
                        key: "content",
                        render: (_, e) => (
                          <div className="entry-cell">
                            <button
                              className="entry-title"
                              onClick={() =>
                                space?.archived || page === "trash"
                                  ? void openHistory(e)
                                  : edit(e)
                              }
                            >
                              {entryLabel(e)}
                            </button>
                            {e.kind === "note" && (
                              <div className="entry-preview">
                                {e.content.replace(/[#*`>]/g, "").slice(0, 160)}
                              </div>
                            )}
                            {e.tags.length > 0 && (
                              <div className="entry-tags">
                                {e.tags.map((t) => (
                                  <Tag key={t} onClick={() => setTag(t)}>
                                    {t}
                                  </Tag>
                                ))}
                              </div>
                            )}
                          </div>
                        ),
                      },
                      {
                        title: page === "trash" ? "Deleted" : "Updated",
                        key: "updated",
                        width: 150,
                        render: (_, e) => (
                          <span className="muted">
                            {dateTime(e.deletedAt ?? e.updatedAt)}
                            <small className="revision">
                              Version {e.revision}
                            </small>
                          </span>
                        ),
                      },
                      {
                        title: "",
                        key: "actions",
                        width: 120,
                        render: (_, e) => entryActions(e),
                      },
                    ]}
                  />
                  <div className="pagination">
                    <span>Page {back.length + 1}</span>
                    <Inline>
                      <Button
                        disabled={!back.length}
                        onClick={() => {
                          setCursor(back.at(-1));
                          setBack((v) => v.slice(0, -1));
                        }}
                      >
                        Previous
                      </Button>
                      <Button
                        disabled={!next}
                        onClick={() => {
                          setBack((v) => [...v, cursor]);
                          setCursor(next!);
                        }}
                      >
                        Next
                      </Button>
                    </Inline>
                  </div>
                </>
              )}
              {page === "tokens" && (
                <>
                  <div className="info-strip">
                    <KeyOutlined />
                    <span>
                      Download a token for each conversation. Suspended tokens
                      can be resumed; revoked tokens cannot.
                    </span>
                  </div>
                  <Table<TokenInfo>
                    rowKey="id"
                    loading={loading}
                    dataSource={tokens}
                    pagination={{ pageSize: 15 }}
                    columns={[
                      {
                        title: "Name",
                        dataIndex: "name",
                        render: (v) => <strong>{v}</strong>,
                      },
                      {
                        title: "Status",
                        dataIndex: "state",
                        render: (v) => (
                          <Tag
                            color={
                              v === "active"
                                ? "green"
                                : v === "suspended"
                                  ? "gold"
                                  : "default"
                            }
                          >
                            {
                              (
                                {
                                  active: "Active",
                                  suspended: "Suspended",
                                  revoked: "Revoked",
                                } as Record<string, string>
                              )[v]
                            }
                          </Tag>
                        ),
                      },
                      {
                        title: "Access",
                        dataIndex: "access",
                        render: (v) =>
                          v === "write" ? "Read & write" : "Read only",
                      },
                      {
                        title: "Last used",
                        dataIndex: "lastUsedAt",
                        render: (v) => (v ? dateTime(v) : "Never used"),
                      },
                      {
                        title: "Created",
                        dataIndex: "createdAt",
                        render: dateTime,
                      },
                      {
                        title: "",
                        key: "actions",
                        render: (_, t) =>
                          t.state !== "revoked" && (
                            <Inline>
                              <Button
                                size="small"
                                onClick={() =>
                                  void perform(
                                    () =>
                                      api(
                                        `/spaces/${spaceId}/tokens/${t.id}`,
                                        "PATCH",
                                        {
                                          state:
                                            t.state === "active"
                                              ? "suspended"
                                              : "active",
                                        },
                                      ),
                                    "Token status updated",
                                  )
                                }
                              >
                                {t.state === "active" ? "Suspend" : "Restore"}
                              </Button>
                              <Popconfirm
                                title="Revoke this token permanently?"
                                description="Conversations using this token will lose access."
                                onConfirm={() =>
                                  perform(
                                    () =>
                                      api(
                                        `/spaces/${spaceId}/tokens/${t.id}`,
                                        "PATCH",
                                        { state: "revoked" },
                                      ),
                                    "Revoked",
                                  )
                                }
                              >
                                <Button size="small" danger>
                                  Revoke
                                </Button>
                              </Popconfirm>
                            </Inline>
                          ),
                      },
                    ]}
                  />
                </>
              )}
              {page === "history" && (
                <>
                  <div className="time-caption">
                    Latest 200 changes · Select a record to explore its versions
                  </div>
                  <Table<Revision>
                    rowKey="id"
                    loading={loading}
                    dataSource={history}
                    pagination={{ pageSize: 20 }}
                    columns={[
                      {
                        title: "Time",
                        dataIndex: "createdAt",
                        width: 165,
                        render: dateTime,
                      },
                      {
                        title: "Action",
                        dataIndex: "action",
                        width: 130,
                        render: (v) => <Tag>{actionLabel[v] ?? v}</Tag>,
                      },
                      {
                        title: "Content",
                        key: "entry",
                        render: (_, r) => (
                          <button
                            className="entry-title"
                            onClick={() => void openHistory(r.snapshot)}
                          >
                            {entryLabel(r.snapshot)}
                          </button>
                        ),
                      },
                      { title: "Version", dataIndex: "revision", width: 80 },
                      {
                        title: "Source",
                        dataIndex: "actor",
                        width: 180,
                        render: (v) =>
                          v === "web" ? (
                            "WebUI"
                          ) : (
                            <Tooltip title={v}>
                              Token · {v.slice(6, 14)}
                            </Tooltip>
                          ),
                      },
                    ]}
                  />
                </>
              )}
              {page === "settings" && space && (
                <div className="settings-grid">
                  <section className="settings-panel">
                    <span className="eyebrow">SPACE DETAILS</span>
                    <h2>Space details</h2>
                    <Form
                      form={settingsForm}
                      layout="vertical"
                      onFinish={(values) =>
                        void perform(
                          () =>
                            api(`/spaces/${spaceId}`, "PUT", {
                              ...values,
                              archived: space.archived,
                            }),
                          "Space details saved",
                        )
                      }
                    >
                      <Form.Item
                        name="name"
                        label="Name"
                        rules={[{ required: true, whitespace: true }]}
                      >
                        <Input maxLength={100} />
                      </Form.Item>
                      <Form.Item name="description" label="Description">
                        <Input.TextArea rows={4} maxLength={2000} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit">
                        Save details
                      </Button>
                    </Form>
                  </section>
                  <section className="settings-panel">
                    <span className="eyebrow">PORTABILITY</span>
                    <h2>Import & export</h2>
                    <p>
                      Export active notes and events as JSON, without access
                      tokens. Database backups include full history and token
                      status.
                    </p>
                    <Inline wrap>
                      <Button
                        icon={<DownloadOutlined />}
                        onClick={() =>
                          void perform(async () => {
                            const data = await api(`/spaces/${spaceId}/export`);
                            download(
                              `exomem-${space.name}-${dayjs().format("YYYY-MM-DD")}.json`,
                              JSON.stringify(data, null, 2),
                              "application/json",
                            );
                          })
                        }
                      >
                        Export JSON
                      </Button>
                      <Upload
                        accept=".json,.md,.markdown"
                        showUploadList={false}
                        disabled={space.archived}
                        beforeUpload={(file) => {
                          const key = newKey();
                          void perform(async () => {
                            const text = await file.text();
                            const data = /\.json$/i.test(file.name)
                              ? JSON.parse(text)
                              : {
                                  format: "exomem/v1",
                                  entries: [
                                    {
                                      data: {
                                        kind: "note",
                                        title: file.name.replace(
                                          /\.(md|markdown)$/i,
                                          "",
                                        ),
                                        tags: [],
                                        content: text,
                                      },
                                    },
                                  ],
                                };
                            const result = await api<{
                              created: number;
                              skipped: number;
                            }>(`/spaces/${spaceId}/import`, "POST", {
                              requestId: key,
                              data,
                            });
                            message.success(
                              `Imported ${result.created}; skipped ${result.skipped} duplicates`,
                            );
                          });
                          return false;
                        }}
                      >
                        <Button
                          icon={<UploadOutlined />}
                          disabled={space.archived}
                        >
                          Import JSON / Markdown
                        </Button>
                      </Upload>
                    </Inline>
                    <p className="muted">
                      Markdown files become individual notes. Importing the same
                      file again skips the duplicate.
                    </p>
                  </section>
                  <section className="settings-panel">
                    <span className="eyebrow">SPACE LIFECYCLE</span>
                    <h2>
                      {space.archived ? "Restore space" : "Archive space"}
                    </h2>
                    <p>
                      Archiving preserves memories and blocks token access.
                      Restoring the space re-enables its active tokens.
                    </p>
                    <Popconfirm
                      title={
                        space.archived
                          ? "Restore this space?"
                          : "Archive this space?"
                      }
                      onConfirm={() =>
                        perform(
                          () =>
                            api(`/spaces/${spaceId}`, "PUT", {
                              name: space.name,
                              description: space.description,
                              archived: !space.archived,
                            }),
                          space.archived ? "Space restored" : "Space archived",
                        )
                      }
                    >
                      <Button>
                        {space.archived ? "Restore space" : "Archive space"}
                      </Button>
                    </Popconfirm>
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>EXOMEM</span>
            <span>Your memories, in your hands.</span>
          </footer>
        </main>
      </Layout>

      <Modal
        title="Create a memory space"
        open={spaceModal}
        onCancel={() => setSpaceModal(false)}
        onOk={() => spaceForm.submit()}
        okText="Create space"
        destroyOnHidden
      >
        <Form
          form={spaceForm}
          layout="vertical"
          onFinish={async (values) => {
            try {
              const result = await api<Space>("/spaces", "POST", values);
              setSpaceId(result.id);
              setSpaceModal(false);
              setPage("timeline");
              reload();
            } catch (e) {
              message.error((e as Error).message);
            }
          }}
        >
          <Form.Item
            name="name"
            label="Space name"
            rules={[
              {
                required: true,
                whitespace: true,
                message: "Please name this space",
              },
            ]}
          >
            <Input
              autoFocus
              placeholder="For example: Life & thoughts"
              maxLength={100}
            />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea
              rows={3}
              placeholder="What would you like this space to remember?"
              maxLength={2000}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={
          editing === "new"
            ? kind === "note"
              ? "New note"
              : "Record event"
            : kind === "note"
              ? "Edit note"
              : "Edit event"
        }
        open={editing !== null}
        onClose={closeEditor}
        size={800}
        destroyOnHidden
        maskClosable={!dirty}
        extra={
          <Inline>
            <Text type="secondary">
              {dirty
                ? "Unsaved"
                : editing && editing !== "new"
                  ? `Version ${editing.revision}`
                  : ""}
            </Text>
            <Button
              type="primary"
              onClick={() => void saveEntry()}
              loading={saving}
              disabled={!ready}
            >
              Save
            </Button>
          </Inline>
        }
      >
        {editing && (
          <>
            <Form
              form={entryForm}
              layout="vertical"
              onValuesChange={() => setDirty(true)}
            >
              {kind === "note" ? (
                <>
                  <Form.Item
                    name="title"
                    label="Title"
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        message: "Please enter a title",
                      },
                    ]}
                  >
                    <Input
                      placeholder="Note title"
                      size="large"
                      maxLength={300}
                    />
                  </Form.Item>
                  <Form.Item name="tags" label="Tags">
                    <Select
                      mode="tags"
                      options={tags.map((t) => ({ value: t, label: t }))}
                      placeholder="Type a tag and press Enter"
                    />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item name="timeKind" label="Event time">
                    <Radio.Group
                      options={[
                        { label: "Date only", value: "date" },
                        { label: "Exact time", value: "instant" },
                      ]}
                    />
                  </Form.Item>
                  {timeKind === "date" ? (
                    <Form.Item
                      name="date"
                      rules={[
                        { required: true, message: "Please select a date" },
                      ]}
                    >
                      <DatePicker allowClear={false} />
                    </Form.Item>
                  ) : (
                    <Form.Item
                      name="instant"
                      rules={[
                        { required: true, message: "Please select a time" },
                      ]}
                      extra={`Enter in ${localZone}; stored in UTC`}
                    >
                      <DatePicker showTime allowClear={false} />
                    </Form.Item>
                  )}
                </>
              )}
            </Form>
            {saveError && (
              <Alert
                className="section-gap"
                type="error"
                showIcon
                title="Not saved"
                description={saveError}
              />
            )}
            <div className="editor-label">
              {kind === "note" ? "Body" : "Event description"}
              <span>Edit the formatted text directly</span>
            </div>
            <Suspense fallback={<Spin />}>
              <Editor
                ref={editorRef}
                key={editing === "new" ? `new-${kind}` : editing.id}
                initial={initialContent}
                onReady={setReady}
                onChange={(value) => {
                  setContent(value);
                  if (value.trim() !== initialContent.trim()) setDirty(true);
                }}
              />
            </Suspense>
          </>
        )}
      </Drawer>
      <Modal
        title="Create an access token"
        open={tokenModal}
        onCancel={() => setTokenModal(false)}
        onOk={() => tokenForm.submit()}
        okText="Create token"
        destroyOnHidden
      >
        <Form
          form={tokenForm}
          layout="vertical"
          initialValues={{ access: "write" }}
          onFinish={async (values) => {
            try {
              const result = await api<{ token: string }>(
                `/spaces/${spaceId}/tokens`,
                "POST",
                values,
              );
              setNewToken({ token: result.token, name: values.name });
              setTokenModal(false);
              reload();
            } catch (e) {
              message.error((e as Error).message);
            }
          }}
        >
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input
              placeholder="For example: October conversations"
              maxLength={200}
            />
          </Form.Item>
          <Form.Item name="access" label="Access">
            <Radio.Group
              options={[
                { label: "Read & write", value: "write" },
                { label: "Read only", value: "read" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="Token created"
        open={!!newToken}
        onCancel={() => setNewToken(null)}
        footer={
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => {
              if (newToken) download("token.txt", `${newToken.token}\n`);
            }}
          >
            Download token.txt
          </Button>
        }
      >
        <p>
          “{newToken?.name}” is ready. Upload the file to a ChatGPT conversation
          for this space.
        </p>
        <Alert
          type="info"
          showIcon
          title="Download this token before closing"
          description="The original file cannot be downloaded again. You can always create a new token."
        />
        <Paragraph className="token-value" copyable={{ text: newToken?.token }}>
          {newToken?.token}
        </Paragraph>
      </Modal>
      <Drawer
        title="Record history"
        open={!!inspecting}
        onClose={() => setInspecting(null)}
        size={860}
        destroyOnHidden
      >
        {inspecting && (
          <>
            <h2 className="history-title">{entryLabel(inspecting)}</h2>
            <Table<Revision>
              rowKey="id"
              size="small"
              dataSource={versions}
              pagination={{ pageSize: 8 }}
              columns={[
                { title: "Version", dataIndex: "revision", width: 70 },
                {
                  title: "Action",
                  dataIndex: "action",
                  render: (v) => actionLabel[v],
                },
                { title: "Time", dataIndex: "createdAt", render: dateTime },
                {
                  title: "",
                  key: "actions",
                  render: (_, r) => (
                    <Button size="small" onClick={() => setSelectedVersion(r)}>
                      View content
                    </Button>
                  ),
                },
              ]}
            />
            {selectedVersion && (
              <section className="version-preview">
                <div className="version-heading">
                  <h3>Version {selectedVersion.revision}</h3>
                  <Popconfirm
                    title={`Restore version ${selectedVersion.revision} as a new version?`}
                    onConfirm={() =>
                      perform(
                        () => restore(inspecting, selectedVersion.revision),
                        "Restored as a new version",
                      )
                    }
                  >
                    <Button disabled={space?.archived}>
                      Restore this version
                    </Button>
                  </Popconfirm>
                </div>
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    {
                      key: "title",
                      label: "Title / date",
                      children:
                        selectedVersion.snapshot.kind === "note"
                          ? selectedVersion.snapshot.title
                          : selectedVersion.snapshot.time?.kind === "date"
                            ? selectedVersion.snapshot.time.date
                            : selectedVersion.snapshot.time?.at,
                    },
                    {
                      key: "tags",
                      label: "Tags",
                      children:
                        selectedVersion.snapshot.tags.join(" · ") || "—",
                    },
                  ]}
                />
                <Suspense fallback={<Spin />}>
                  <Editor
                    key={selectedVersion.id}
                    initial={selectedVersion.snapshot.content}
                    readonly
                  />
                </Suspense>
              </section>
            )}
          </>
        )}
      </Drawer>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(
  <ConfigProvider
    locale={enUS}
    theme={{
      token: {
        colorPrimary: "#32685b",
        borderRadius: 2,
        colorBgLayout: "#f5f5f0",
        colorText: "#233530",
        colorBorder: "#dce2da",
        fontFamily:
          'Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      },
      components: {
        Button: { controlHeight: 36 },
        Table: { headerBg: "#edf0e9", cellPaddingBlock: 18 },
        Menu: {
          darkItemBg: "#172c28",
          darkSubMenuItemBg: "#172c28",
          darkItemSelectedBg: "#304a42",
          darkItemSelectedColor: "#e5efc7",
          itemBorderRadius: 2,
        },
        Layout: { siderBg: "#172c28", bodyBg: "#f5f5f0" },
      },
    }}
  >
    <AntApp>
      <Exomem />
    </AntApp>
  </ConfigProvider>,
);
