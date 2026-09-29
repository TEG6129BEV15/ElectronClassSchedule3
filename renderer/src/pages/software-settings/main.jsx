import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Input, Select, Switch } from '@fluentui/react-components';
import { AppTheme, initialThemeFromQuery } from '../../common/theme.jsx';
import { useThemePack } from '../../common/themePack.js';
import TitleBar from '../../common/TitleBar.jsx';
import { ipcRenderer } from '../../common/electron.js';
import { Svg, ICONS } from '../../common/icons.jsx';
import ComponentsPage, { createComponentId, getConfiguredComponentRows } from './ComponentsPage.jsx';
import ThemePacksPage from './ThemePacksPage.jsx';
import '../../common/tokens.css';
import '../../common/chrome.css';
import './software-settings.css';

const NAV_ITEMS = [
  { page: 'basic', label: '基础设置', icon: ICONS.basicSettings },
  { page: 'components', label: '组件设置', icon: ICONS.components },
  { page: 'appearance', label: '外观', icon: ICONS.style },
  { page: 'themes', label: '主题', icon: ICONS.palette },
  { page: 'reminder', label: '提醒', icon: ICONS.reminder },
];

const WEEK_COUNTS = [2, 3, 4];

// ==== 多周轮换偏移 ====
// 与主界面 js/index.js 的锚点逻辑保持一致（file:// 页面共享同一 localStorage）
function getRotationWeekStart(date) {
  const weekStart = new Date(date);
  const day = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function getRotationWeekNumber(rotationWeeks) {
  let anchors = {};
  try {
    const parsed = JSON.parse(localStorage.getItem('rotationWeekAnchors') || '{}');
    if (parsed && typeof parsed === 'object') anchors = parsed;
  } catch (error) { /* 锚点缺失时按“本周为第 1 周”处理 */ }
  const now = new Date();
  const currentWeekStart = getRotationWeekStart(now);
  let anchor = Number(anchors[rotationWeeks]);
  if (!Number.isFinite(anchor) || anchor > now.getTime()) {
    anchor = currentWeekStart.getTime();
  } else {
    anchor = getRotationWeekStart(new Date(anchor)).getTime();
  }
  return Math.max(0, Math.round((currentWeekStart.getTime() - anchor) / (7 * 24 * 60 * 60 * 1000)));
}

// 本周实际生效的轮换周次（0 基）：主界面按 (周数 + 偏移) % 周数 取科目，这里保持一致
function getEffectiveRotationWeek(rotationWeeks, rotationOffset) {
  const configured = Number(rotationOffset?.[rotationWeeks]);
  const offset = Number.isInteger(configured) ? configured : 0;
  const weekNumber = getRotationWeekNumber(rotationWeeks);
  return (((weekNumber + offset) % rotationWeeks) + rotationWeeks) % rotationWeeks;
}

// 外观参数规格。unit='px' 表示长度值：文本框里只填数字（多个数字用空格分隔，
// 如内边距 "8 14"），保存时自动给每个数字补 px；背景透明度是无单位数字。
const CSS_VAR_SPECS = [
  { var: '--center-font-size', label: '中心字号', unit: 'px' },
  { var: '--corner-font-size', label: '角标字号', unit: 'px' },
  { var: '--countdown-font-size', label: '倒计时字号', unit: 'px' },
  { var: '--global-border-radius', label: '全局圆角', unit: 'px' },
  { var: '--global-bg-opacity', label: '背景透明度', unit: '' },
  { var: '--container-bg-padding', label: '容器内边距', unit: 'px' },
  { var: '--countdown-bg-padding', label: '倒计时内边距', unit: 'px' },
  { var: '--container-space', label: '组件间距', unit: 'px' },
  { var: '--top-space', label: '顶部间距', unit: 'px' },
  { var: '--main-horizontal-space', label: '主水平间距', unit: 'px' },
  { var: '--divider-width', label: '分隔线宽度', unit: 'px' },
  { var: '--divider-margin', label: '分隔线边距', unit: 'px' },
  { var: '--triangle-size', label: '三角尺寸', unit: 'px' },
  { var: '--sub-font-size', label: '副文字号', unit: 'px' },
];

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

// 文件里存的是 "8px 14px"，输入框里只显示 "8 14"
function cssValueToDraft(spec, rawValue) {
  const text = String(rawValue ?? '').trim();
  if (!text) return '';
  if (spec.unit === 'px') return text.replace(/px/gi, '').replace(/\s+/g, ' ').trim();
  return text;
}

// 把输入框草稿转回 CSS 值；含非法数字时返回 null
function draftToCssValue(spec, draft) {
  const tokens = String(draft ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  if (spec.unit === 'px') {
    if (!tokens.every((token) => NUMBER_RE.test(token))) return null;
    return tokens.map((token) => `${token}px`).join(' ');
  }
  if (tokens.length !== 1 || !NUMBER_RE.test(tokens[0])) return null;
  return tokens[0];
}

function SoftwareSettingsApp({ onThemeModeChange }) {
  const configRef = useRef(null);
  const settingsRef = useRef(null);

  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((tick) => tick + 1), []);
  const [activePage, setActivePage] = useState('basic');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [cssStyleObj, setCssStyleObj] = useState({});
  const [reminderClass, setReminderClass] = useState({});
  const [reminderCustom, setReminderCustom] = useState([]);
  const [activeTheme, setActiveTheme] = useState('');
  const [timeOffsetText, setTimeOffsetText] = useState('0');
  // 首帧与 URL 参数（主进程读磁盘注入）保持一致，避免挂载时 effect 先把 auto
  // 推给 Root 造成浅色闪帧；若之后 loadSettings 回包慢/失败，窗口就会残留浅色
  const [themeMode, setThemeMode] = useState(() => initialThemeFromQuery() || 'auto');
  const [positionMode, setPositionMode] = useState('top');
  // 首次读取完成前，各类“即改即生效”的自动保存不能误触发
  const loadedRef = useRef(false);
  // 各设置域共用的防抖定时器
  const persistTimersRef = useRef(new Map());
  // 左侧导航折叠状态持久化（file:// 下 localStorage 与主界面共享，使用独立键名）
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('softwareSettingsNavCollapsed') === '1');
  const toggleNav = useCallback(() => {
    setNavCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('softwareSettingsNavCollapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  const settings = settingsRef.current;
  const config = configRef.current;
  const rotationOffset = settings?.rotation_offset || {};

  const loadSettings = useCallback(() => {
    loadedRef.current = false;
    Promise.all([
      ipcRenderer.invoke('read-config-file'),
      ipcRenderer.invoke('read-settings-file'),
    ]).then(([data, settingsData]) => {
      configRef.current = data;
      settingsRef.current = settingsData;
      settingsRef.current.component_layout = getConfiguredComponentRows(settingsData, data);
      setRows(settingsRef.current.component_layout);
      setSelectedId(null);
      // 外观参数以“去掉 px 的草稿”形式放进输入框
      const drafts = {};
      CSS_VAR_SPECS.forEach((spec) => {
        const draft = cssValueToDraft(spec, settingsData?.css_style?.[spec.var]);
        if (draft !== '') drafts[spec.var] = draft;
      });
      setCssStyleObj(drafts);
      setReminderClass(settingsData?.reminder_class || {});
      setReminderCustom(Array.isArray(settingsData?.reminder_custom) ? settingsData.reminder_custom : []);
      setThemeMode(settingsData?.theme_mode || 'auto');
      setPositionMode(settingsData?.window_position || 'top');
      setActiveTheme(settingsData?.active_theme || '');
      setTimeOffsetText(String(Number(localStorage.getItem('timeOffset') || 0)));
      setStatus('');
      loadedRef.current = true;
      bump();
    }).catch((error) => {
      console.error(error);
      setStatus('读取配置文件失败');
    });
  }, [bump]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (onThemeModeChange) onThemeModeChange(themeMode);
  }, [themeMode, onThemeModeChange]);

  // ===== 统一持久化：所有设置操作后立即（或短暂防抖）写入并生效，无需保存按钮 =====
  // options.skipReload：该项变更已通过专用预览通道热应用（如窗口位置），
  // 落盘后不需要主窗口整页 reload
  const persistSettings = useCallback((mutate, message, options) => {
    if (!settingsRef.current) return;
    const nextSettings = JSON.parse(JSON.stringify(settingsRef.current));
    mutate(nextSettings);
    // 乐观更新引用，连续编辑时基于最新值叠加
    settingsRef.current = nextSettings;
    ipcRenderer.invoke('save-settings-file', nextSettings, options).then(() => {
      setStatus(message || '已自动保存并生效');
      bump();
    }).catch((error) => {
      console.error(error);
      setStatus('自动保存失败，请检查配置格式');
    });
  }, [bump]);

  const schedulePersist = useCallback((key, mutate, message, delay = 500) => {
    const timers = persistTimersRef.current;
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      persistSettings(mutate, message);
    }, delay));
  }, [persistSettings]);

  const changeRotationOffset = (weeks, selectedWeek) => {
    if (!settingsRef.current) return;
    // 语义是“本周按第 selectedWeek+1 周显示”：锚点不动，把选择换算成偏移量保存，
    // 与主界面 (周数 + 偏移) % 周数 的计算方式一致，之后每周自动顺延
    const weekNumber = getRotationWeekNumber(weeks);
    const nextOffset = (((selectedWeek - weekNumber) % weeks) + weeks) % weeks;
    const nextSettings = JSON.parse(JSON.stringify(settingsRef.current));
    nextSettings.rotation_offset = {
      2: Number(nextSettings.rotation_offset?.[2] ?? 0),
      3: Number(nextSettings.rotation_offset?.[3] ?? 0),
      4: Number(nextSettings.rotation_offset?.[4] ?? 0),
    };
    nextSettings.rotation_offset[weeks] = nextOffset;
    ipcRenderer.invoke('save-settings-file', nextSettings).then(() => {
      settingsRef.current = nextSettings;
      setStatus('轮换偏移已保存并生效');
      bump();
    }).catch((error) => {
      console.error(error);
      setStatus('保存失败，请检查配置格式');
    });
  };

  const applyTimeOffset = () => {
    const value = Number(timeOffsetText);
    if (!Number.isFinite(value)) {
      setStatus('请输入有效的整数秒数');
      return;
    }
    const seconds = Math.trunc(value) % 10000000000000;
    // 失焦会频繁触发：与已生效值一致时不重复下发、不弹提示
    if (String(seconds) === String(localStorage.getItem('timeOffset') || '0')) {
      setTimeOffsetText(String(seconds));
      return;
    }
    localStorage.setItem('timeOffset', String(seconds));
    ipcRenderer.send('set-time-offset', seconds);
    setTimeOffsetText(String(seconds));
    setStatus('时间偏移已生效');
  };

  // 深浅色：选择即持久化，主进程广播到全部窗口
  const changeThemeMode = (nextMode) => {
    setThemeMode(nextMode);
    persistSettings((nextSettings) => {
      nextSettings.theme_mode = nextMode;
    }, '深浅色已生效');
  };

  // 窗口位置：先经预览通道让主窗口热重排并播放 FLIP 过渡动画（不 reload），
  // 再落盘且告知主进程跳过 reload，避免整页重载把动画打断成一帧跳变
  const changePositionMode = (nextMode) => {
    setPositionMode(nextMode);
    ipcRenderer.send('window-position-preview', nextMode);
    persistSettings((nextSettings) => {
      nextSettings.window_position = nextMode;
    }, '窗口位置已生效', { skipReload: true });
  };

  // 组件布局同时写 config（组件专属选项）与 settings（布局）
  const flushComponentSettings = useCallback(() => {
    if (!configRef.current || !settingsRef.current) return;
    const nextConfig = JSON.parse(JSON.stringify(configRef.current));
    const nextSettings = JSON.parse(JSON.stringify(settingsRef.current));
    const layout = rows.map((row) => row.map((component) => ({
      id: component.id,
      type: component.type,
      options: { ...(component.options || {}) },
    })));
    if (!layout.some((row) => row.some((component) => component.type === 'schedule'))) {
      layout.unshift([{ id: createComponentId('schedule'), type: 'schedule', options: {} }]);
    }
    nextSettings.component_layout = layout;
    const firstOf = (type) => layout.flat().find((component) => component.type === type);
    const week = firstOf('week');
    const countdown = firstOf('countdown');
    const time = firstOf('time');
    if (week) nextConfig.week_display = week.options.display !== false;
    if (countdown) nextConfig.countdown_target = countdown.options.target || '';
    if (time) nextConfig.time_source = time.options.source === 'system' ? 'system' : 'offset';
    Promise.all([
      ipcRenderer.invoke('save-config-file', nextConfig),
      ipcRenderer.invoke('save-settings-file', nextSettings),
    ]).then(() => {
      configRef.current = nextConfig;
      settingsRef.current = nextSettings;
      settingsRef.current.component_layout = layout;
      setStatus('组件设置已自动保存并生效');
      bump();
    }).catch((error) => {
      console.error(error);
      setStatus('组件设置自动保存失败');
    });
  }, [rows, bump]);

  // rows 任意变动（增删/排序/选项）后防抖落盘，不再需要“保存组件设置”按钮
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = setTimeout(flushComponentSettings, 600);
    return () => clearTimeout(timer);
  }, [rows, flushComponentSettings]);

  // 外观参数：输入后防抖自动保存（px 由草稿自动补全）
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = setTimeout(() => {
      const nextCssStyle = {};
      for (const spec of CSS_VAR_SPECS) {
        const value = draftToCssValue(spec, cssStyleObj[spec.var] ?? '');
        if (value === null) {
          setStatus(`「${spec.label}」只能填写数字${spec.unit === 'px' ? '（多个数字用空格分隔）' : ''}`);
          return;
        }
        if (value !== '') nextCssStyle[spec.var] = value;
      }
      persistSettings((nextSettings) => {
        nextSettings.css_style = nextCssStyle;
      }, '外观设置已自动保存并生效');
    }, 500);
    return () => clearTimeout(timer);
  }, [cssStyleObj, persistSettings]);

  // 提醒设置（开关/秒数/文案/自定义提醒）统一防抖落盘
  const persistReminder = (classOverride, customOverride) => {
    const nextClass = classOverride !== undefined ? classOverride : reminderClass;
    const nextCustom = customOverride !== undefined ? customOverride : reminderCustom;
    schedulePersist('reminder', (nextSettings) => {
      nextSettings.reminder_class = nextClass;
      nextSettings.reminder_custom = nextCustom;
    }, '提醒设置已自动保存并生效', 400);
  };

  // 主题包开关：最多启用一个；传空字符串表示全部关闭、恢复默认主题
  const selectTheme = (themeId) => {
    setActiveTheme(themeId);
    persistSettings((nextSettings) => {
      if (themeId) nextSettings.active_theme = themeId;
      else delete nextSettings.active_theme;
    }, themeId ? '主题已切换并立即生效' : '已恢复默认主题');
  };

  return (
    <>
      <TitleBar title="软件设置" />
      <div className={`app ss-app app-shell${navCollapsed ? ' nav-collapsed' : ''}`}>
        <aside className="nav-sidebar">
          <div className="nav-rail-top">
            <button
              type="button"
              className="nav-toggle"
              title={navCollapsed ? '展开菜单' : '折叠菜单'}
              aria-label={navCollapsed ? '展开菜单' : '折叠菜单'}
              onClick={toggleNav}
            >
              <Svg size={18} viewBox="0 0 20 20" html={ICONS.menu} strokeWidth={1.6} />
            </button>
            <span className="nav-rail-brand">软件设置</span>
          </div>
          <nav className="nav-list">
            {NAV_ITEMS.map((item) => (
              <button
                type="button"
                key={item.page}
                className={`nav-item${activePage === item.page ? ' active' : ''}`}
                title={item.label}
                onClick={() => { setActivePage(item.page); setStatus(''); }}
              >
                <Svg size={24} viewBox="0 0 24 24" html={item.icon} />
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="shell-body">
          <div className="shell-scroll">
            <main className="main-content">
            <section className={`ss-page${activePage === 'basic' ? ' active' : ''}`}>
              <div className="page-header">
                <h1 className="page-title">基础设置</h1>
                <p className="page-intro">调整课表窗口的显示方式、倒计时和多周轮换。</p>
              </div>
              <div className="panel">
                <h3>多周轮换偏移</h3>
                <div className="settings-grid">
                  {WEEK_COUNTS.map((weeks) => {
                    // 显示本周实际生效的轮换周次（随锚点每周自动推进），而不是静态偏移值
                    const effective = getEffectiveRotationWeek(weeks, rotationOffset);
                    return (
                      <div className="field" key={weeks}>
                        <label htmlFor={`rotationOffset${weeks}`}>{weeks === 2 ? '二周' : weeks === 3 ? '三周' : '四周'}轮换</label>
                        <Select
                          id={`rotationOffset${weeks}`}
                          value={String(effective)}
                          onChange={(event) => changeRotationOffset(weeks, Number(event.target.value))}
                        >
                          {Array.from({ length: weeks }, (_, index) => (
                            <option key={index} value={index}>第 {index + 1} 周</option>
                          ))}
                        </Select>
                      </div>
                    );
                  })}
                </div>
                <p className="field-help">显示本周实际按第几周轮换，每周自动推进到下一周；若与实际不符，选择本周应显示的周次即可校准，修改后立即生效并自动保存。</p>
              </div>

              <div className="panel">
                <h3>时间偏移</h3>
                <div className="time-offset-field">
                  <div className="field">
                    <label htmlFor="timeOffsetInput">偏移秒数</label>
                    <Input
                      id="timeOffsetInput"
                      type="number"
                      step="1"
                      value={timeOffsetText}
                      onChange={(event) => setTimeOffsetText(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') applyTimeOffset(); }}
                      onBlur={applyTimeOffset}
                    />
                    <p className="field-help">设置课表计时与系统时间的偏移秒数，正数加快、负数减慢；输入后点击其他地方或按回车即生效，重启仍然保留。</p>
                  </div>
                </div>
              </div>

              <div className="panel">
                <h3>窗口位置</h3>
                <div className="field">
                  <label htmlFor="positionModeSelect">排列方式</label>
                  <Select
                    id="positionModeSelect"
                    value={positionMode}
                    onChange={(event) => changePositionMode(event.target.value)}
                  >
                    <option value="top">顶部居中</option>
                    <option value="top-right">顶部靠右</option>
                    <option value="right">右侧竖排</option>
                  </Select>
                  <p className="field-help">控制课表条在屏幕上的排列位置：顶部居中、顶部靠右（每行右对齐），或右侧竖排（各行从右到左、行内组件自上而下），选择后立即生效并自动保存。</p>
                </div>
              </div>

              <div className="panel">
                <h3>深浅色</h3>
                <div className="field">
                  <label htmlFor="themeModeSelect">主题模式</label>
                  <Select
                    id="themeModeSelect"
                    value={themeMode}
                    onChange={(event) => changeThemeMode(event.target.value)}
                  >
                    <option value="auto">跟随系统</option>
                    <option value="dark">深色</option>
                    <option value="light">浅色</option>
                  </Select>
                  <p className="field-help">控制主界面课表条和所有设置窗口的深浅色，选择后立即生效并自动保存。</p>
                </div>
              </div>
            </section>

            <section className={`ss-page${activePage === 'components' ? ' active' : ''}`}>
              <div className="page-header">
                <h1 className="page-title">组件设置</h1>
                <p className="page-intro">管理组件的显示位置、顺序和专属选项。课表组件包含每节课的倒计时。</p>
              </div>
              <ComponentsPage
                rows={rows}
                setRows={setRows}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                settingsRef={settingsRef}
                bump={bump}
              />
            </section>

            <section className={`ss-page${activePage === 'appearance' ? ' active' : ''}`}>
              <div className="page-header">
                <h1 className="page-title">外观</h1>
                <p className="page-intro">调整主界面样式参数，只需填写数字（长度单位 px 会自动添加），修改后立即生效。</p>
              </div>
              <div className="panel">
                <h3>样式参数</h3>
                <div className="settings-grid">
                  {CSS_VAR_SPECS.map((spec) => (
                    <div className="field" key={spec.var}>
                      <label htmlFor={`cssVar-${spec.var}`}>{spec.label}</label>
                      <div className="unit-field">
                        <Input
                          id={`cssVar-${spec.var}`}
                          type={spec.unit === 'px' ? 'text' : 'number'}
                          inputMode="decimal"
                          step={spec.unit === 'px' ? undefined : '0.1'}
                          min={spec.unit === 'px' ? undefined : 0}
                          max={spec.unit === 'px' ? undefined : 1}
                          placeholder={spec.unit === 'px' ? '如 8 或 8 14' : '0 - 1'}
                          value={cssStyleObj[spec.var] || ''}
                          onChange={(event) => {
                            // 长度框只允许数字、小数点、负号和空格；单位 px 不允许手输
                            const v = spec.unit === 'px'
                              ? event.target.value.replace(/[^\d.\s-]/g, '')
                              : event.target.value;
                            setCssStyleObj((prev) => {
                              const next = { ...prev };
                              if (v === '') delete next[spec.var];
                              else next[spec.var] = v;
                              return next;
                            });
                          }}
                        />
                        {spec.unit === 'px' && <span className="unit-suffix">px</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="field-help">内边距等需要两个数值的参数，用空格分隔（如“8 14”）；留空则恢复默认值。</p>
              </div>
            </section>

            <section className={`ss-page${activePage === 'themes' ? ' active' : ''}`}>
              <ThemePacksPage activeTheme={activeTheme} onSelectTheme={selectTheme} />
            </section>

            <section className={`ss-page${activePage === 'reminder' ? ' active' : ''}`}>
              <div className="page-header">
                <h1 className="page-title">提醒</h1>
                <p className="page-intro">在主界面课表条上触发提醒遮罩，上下课自动提醒和自定义文本提醒。</p>
              </div>
              <div className="panel">
                <h3>上下课提醒</h3>
                <p className="field-help">在即将上课、上课、下课时自动触发遮罩提醒，绿色=上课/即将上课，黄色=下课。</p>
                <div className="settings-grid">
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Switch
                        checked={reminderClass.upcoming_enabled || false}
                        onChange={(e, d) => {
                          const next = { ...reminderClass, upcoming_enabled: d.checked };
                          setReminderClass(next);
                          persistReminder(next);
                        }}
                      />
                      即将上课提醒
                    </label>
                    <Input
                      type="number"
                      step="1"
                      value={String(reminderClass.upcoming_seconds ?? 300)}
                      onChange={(e) => {
                        const next = { ...reminderClass, upcoming_seconds: Number(e.target.value) };
                        setReminderClass(next);
                        persistReminder(next);
                      }}
                      style={{ marginTop: '8px' }}
                    />
                    <p className="field-help">距离上课剩余多少秒时提醒</p>
                  </div>
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Switch
                        checked={reminderClass.start_enabled || false}
                        onChange={(e, d) => {
                          const next = { ...reminderClass, start_enabled: d.checked };
                          setReminderClass(next);
                          persistReminder(next);
                        }}
                      />
                      上课提醒
                    </label>
                  </div>
                  <div className="field">
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Switch
                        checked={reminderClass.end_enabled || false}
                        onChange={(e, d) => {
                          const next = { ...reminderClass, end_enabled: d.checked };
                          setReminderClass(next);
                          persistReminder(next);
                        }}
                      />
                      下课提醒
                    </label>
                  </div>
                </div>
                <div className="settings-grid" style={{ marginTop: '14px' }}>
                  <div className="field">
                    <label htmlFor="rcUpcomingText">即将上课文字</label>
                    <Input
                      id="rcUpcomingText"
                      type="text"
                      value={reminderClass.upcoming_text || ''}
                      onChange={(e) => {
                        const next = { ...reminderClass, upcoming_text: e.target.value };
                        setReminderClass(next);
                        persistReminder(next);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="rcStartText">上课文字</label>
                    <Input
                      id="rcStartText"
                      type="text"
                      value={reminderClass.start_text || ''}
                      onChange={(e) => {
                        const next = { ...reminderClass, start_text: e.target.value };
                        setReminderClass(next);
                        persistReminder(next);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="rcEndText">下课文字</label>
                    <Input
                      id="rcEndText"
                      type="text"
                      value={reminderClass.end_text || ''}
                      onChange={(e) => {
                        const next = { ...reminderClass, end_text: e.target.value };
                        setReminderClass(next);
                        persistReminder(next);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3>自定义文本提醒</h3>
                  <Button className="win-small" onClick={() => {
                    const id = `rc-${Date.now()}`;
                    const updated = [...reminderCustom, { id, time: '12:00', text: '', color: '#114514', duration: 5000 }];
                    setReminderCustom(updated);
                    persistReminder(undefined, updated);
                  }}>新增</Button>
                </div>
                <p className="field-help">每天到指定时间触发提醒，可设多条。遮罩从课表中央扩散展开并显示文字。</p>
                {reminderCustom.length === 0 ? (
                  <div className="empty" style={{ padding: '12px' }}>暂无自定义提醒，点击"新增"按钮添加。</div>
                ) : (
                  reminderCustom.map((item, i) => (
                    <div key={item.id} className="settings-grid" style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--colorNeutralStroke2)' }}>
                      <div className="field">
                        <label>时间</label>
                        <Input
                          type="text"
                          placeholder="HH:MM"
                          value={item.time || ''}
                          onChange={(e) => {
                            const updated = reminderCustom.map((it, j) => j === i ? { ...it, time: e.target.value } : it);
                            setReminderCustom(updated);
                            persistReminder(undefined, updated);
                          }}
                        />
                      </div>
                      <div className="field">
                        <label>提醒文字</label>
                        <Input
                          type="text"
                          value={item.text || ''}
                          onChange={(e) => {
                            const updated = reminderCustom.map((it, j) => j === i ? { ...it, text: e.target.value } : it);
                            setReminderCustom(updated);
                            persistReminder(undefined, updated);
                          }}
                        />
                      </div>
                      <div className="field">
                        <label>遮罩颜色</label>
                        <input
                          type="color"
                          className="native-color"
                          value={item.color || '#114514'}
                          onChange={(e) => {
                            const updated = reminderCustom.map((it, j) => j === i ? { ...it, color: e.target.value } : it);
                            setReminderCustom(updated);
                            persistReminder(undefined, updated);
                          }}
                        />
                      </div>
                      <div className="field">
                        <label>持续毫秒</label>
                        <Input
                          type="number"
                          step="100"
                          value={String(item.duration ?? 5000)}
                          onChange={(e) => {
                            const updated = reminderCustom.map((it, j) => j === i ? { ...it, duration: Number(e.target.value) } : it);
                            setReminderCustom(updated);
                            persistReminder(undefined, updated);
                          }}
                        />
                      </div>
                      <div className="field" style={{ alignSelf: 'flex-end' }}>
                        <Button className="win-small" onClick={() => {
                          const updated = reminderCustom.filter((_, j) => j !== i);
                          setReminderCustom(updated);
                          persistReminder(undefined, updated);
                        }}>删除</Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            </main>
          </div>
          <div className="shell-status" aria-live="polite">{status}</div>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<SoftwareSettingsRoot />);

function SoftwareSettingsRoot() {
  // 主题包（Theme 文件夹）加载
  useThemePack();
  // 首帧优先使用主进程通过 URL 参数注入的已保存主题模式，避免窗口打开瞬间闪现浅色
  const [mode, setMode] = useState(() => initialThemeFromQuery() || 'auto');
  useEffect(() => {
    // URL 参数已由主进程读磁盘注入，足够可靠；若无条件异步读取，回包可能基于
    // 预览前的旧文件内容把主题错误覆盖回去（暗色残留浅色打底的竞态根因）
    if (initialThemeFromQuery()) return;
    ipcRenderer.invoke('read-settings-file').then((s) => {
      setMode(s?.theme_mode || 'auto');
    }).catch(() => {});
  }, []);
  return (
    <AppTheme mode={mode}>
      <SoftwareSettingsApp onThemeModeChange={setMode} />
    </AppTheme>
  );
}
