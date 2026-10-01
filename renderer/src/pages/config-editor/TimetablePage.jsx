import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Input, Select } from '@fluentui/react-components';
import { Svg, ICONS } from '../../common/icons.jsx';
import { createCardId, timeToMinutes } from './config-utils.js';
import { beginPointerGesture, createDragGhost } from '../../common/pointerDnd.js';

// 计算每张“上课”卡片保存后的节次徽标
function computeBadges(cards) {
  const badges = new Map();
  const classCards = cards
    .map((card, domIndex) => ({ id: card.id, domIndex, minutes: timeToMinutes(card.start) }))
    .filter((item, index) => cards[index].type === 'class')
    .sort((a, b) => {
      const av = a.minutes >= 0 ? a.minutes : Number.MAX_SAFE_INTEGER;
      const bv = b.minutes >= 0 ? b.minutes : Number.MAX_SAFE_INTEGER;
      return av - bv || a.domIndex - b.domIndex;
    });
  classCards.forEach((item, index) => {
    badges.set(item.id, item.minutes >= 0 ? `第 ${index + 1} 节` : '开始时间未填');
  });
  return badges;
}

function minutesToTimeText(totalMinutes) {
  const clamped = Math.max(0, Math.min(totalMinutes, 23 * 60 + 59));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function parseDurationMinutes(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function TimetableCard({
  card,
  index,
  badge,
  invalid,
  draggableEnabled,
  onPointerDownHandle,
  onDragStart,
  onDragEnd,
  onTouchDragHandle,
  onChange,
  onRemove,
}) {
  return (
    <div
      className={`timetable-card${invalid ? ' invalid' : ''}`}
      data-card-index={index}
      draggable={draggableEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span
        className="drag-handle"
        title="拖动调整顺序"
        onPointerDown={(event) => {
          onPointerDownHandle();
          onTouchDragHandle?.(event);
        }}
      >
        <Svg size={10} viewBox="0 0 10 16" html={ICONS.dragDots} strokeWidth={0} />
      </span>
      <Select
        className="timetable-type-select"
        title="时间段类型"
        value={card.type}
        onChange={(event) => {
          const type = event.target.value;
          onChange({
            type,
            name: type === 'break' && !String(card.name || '').trim() ? '课间' : card.name,
          });
        }}
      >
        <option value="class">上课</option>
        <option value="break">下课</option>
      </Select>
      <Input
        className="timetable-time"
        type="time"
        step="60"
        title="开始时间"
        value={card.start}
        onChange={(event) => onChange({ start: event.target.value })}
      />
      <span className="range-sep">–</span>
      <Input
        className="timetable-time"
        type="time"
        step="60"
        title="结束时间"
        value={card.end}
        onChange={(event) => onChange({ end: event.target.value })}
      />
      {card.type === 'break' && (
        <Input
          className="break-name"
          placeholder="课间名称（如：大课间）"
          value={card.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      )}
      {card.type === 'class' && (
        <span className="class-badge" title={badge || ''}>{badge || ''}</span>
      )}
      <Button
        className="win-icon danger-outline"
        title="删除该时间段"
        aria-label="删除该时间段"
        icon={<Svg size={15} viewBox="0 0 16 16" html={ICONS.trash} strokeWidth={1.3} />}
        onClick={onRemove}
      />
    </div>
  );
}

// 图形化时间线：与卡片列表编辑同一份 cards 草稿，任何修改实时双向同步，
// 但仍需点击工具栏“保存到 scheduleConfig.js”才会写入配置文件。
// 支持：方块上下边缘拖拽改时间（5 分钟吸附）、点击方块内联编辑、纵向放缩。
const PX_PER_MINUTE_DEFAULT = 1.6;
const PX_PER_MINUTE_MIN = 0.4;
const PX_PER_MINUTE_MAX = 8;
const SNAP_MINUTES = 5;
const MIN_SLOT_MINUTES = 5;
const DAY_MAX_MINUTES = 23 * 60 + 59;

function clampZoom(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return PX_PER_MINUTE_DEFAULT;
  return Math.min(PX_PER_MINUTE_MAX, Math.max(PX_PER_MINUTE_MIN, parsed));
}

function snapMinutes(value) {
  return Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;
}

// 依据当前放缩比例选择合适的刻度间隔，保证刻度间距不小于约 42px
function tickStepFor(ppm) {
  const steps = [10, 15, 30, 60, 120];
  return steps.find((step) => step * ppm >= 42) || 120;
}

function computeRange(items) {
  const validItems = items.filter((item) => item.valid);
  if (!validItems.length) return { rangeStart: 8 * 60, rangeEnd: 18 * 60 };
  const rangeStart = Math.floor(Math.min(...validItems.map((item) => item.start)) / 60) * 60;
  let rangeEnd = Math.ceil(Math.max(...validItems.map((item) => item.end)) / 60) * 60;
  if (rangeEnd <= rangeStart) rangeEnd = rangeStart + 60;
  return { rangeStart, rangeEnd };
}

function TimelineView({ cards, groupName, onAddClass, onAddBreak, onChangeCard, onRemoveCard }) {
  const scrollRef = useRef(null);
  const panelRef = useRef(null);
  const popoverRef = useRef(null);
  const blockRefs = useRef(new Map());
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const hoverRef = useRef(false);

  // 纵向放缩（像素/分钟），编辑器级偏好持久化
  const [ppm, setPpmState] = useState(() => {
    const stored = parseFloat(localStorage.getItem('timetableTimelineZoom'));
    return Number.isFinite(stored) ? clampZoom(stored) : PX_PER_MINUTE_DEFAULT;
  });
  const ppmRef = useRef(ppm);
  ppmRef.current = ppm;
  const setPpm = (value) => {
    const next = clampZoom(value);
    ppmRef.current = next;
    setPpmState(next);
    localStorage.setItem('timetableTimelineZoom', String(next));
  };
  // 放缩锚点：{ time, viewportY } —— 光标/视口中心对应的时刻放缩前后保持不动
  const anchorRef = useRef(null);

  // 边缘拖拽状态：{ id, edge: 'start'|'end'|'move', value }（value 为吸附后的分钟数；
  // move 模式下 value 表示新的开始时间，时长不变）
  const [drag, setDrag] = useState(null);
  const dragBaseRef = useRef(null);
  const dragRafRef = useRef(0);
  const dragClientYRef = useRef(0);
  const suppressClickRef = useRef(false);
  // 整块平移：pointerdown 后先记录起点，位移超过阈值才判定为拖拽，
  // 否则按点击处理（打开内联编辑浮层）
  const movePendingRef = useRef(null);

  // 点击方块后的内联编辑器
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [editorPos, setEditorPos] = useState(null);

  // items 合并拖拽预览（拖到当前时间范围外时画布也能实时扩展）
  const items = cards.map((card, index) => {
    let start = timeToMinutes(card.start);
    let end = timeToMinutes(card.end);
    if (drag && drag.id === card.id) {
      if (drag.edge === 'start') {
        start = drag.value;
      } else if (drag.edge === 'end') {
        end = drag.value;
      } else {
        // 整块平移：时长保持不变，value 为吸附后的新开始分钟数
        const duration = end - start;
        start = drag.value;
        end = drag.value + duration;
      }
    }
    return { card, index, start, end, valid: start >= 0 && end >= 0 && end > start };
  });
  const validItems = items.filter((item) => item.valid);
  const invalidCount = items.length - validItems.length;
  const { rangeStart, rangeEnd } = computeRange(items);
  const canvasHeight = (rangeEnd - rangeStart) * ppm;
  const tickStep = tickStepFor(ppm);

  // 放缩后按锚点恢复滚动位置
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = Math.max(0, (anchor.time - rangeStart) * ppm - anchor.viewportY);
  }, [ppm, rangeStart]);

  const zoomBy = (factor, viewportY) => {
    const el = scrollRef.current;
    if (!el) return;
    const y = viewportY ?? el.clientHeight / 2;
    const time = rangeStart + (el.scrollTop + y) / ppmRef.current;
    anchorRef.current = { time, viewportY: y };
    setPpm(ppmRef.current * factor);
  };

  // Ctrl + 滚轮（鼠标）/ 双指捏合（触控板在 Chromium 中表现为 ctrlKey 滚轮）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const norm = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-norm * 0.0015);
      const rect = el.getBoundingClientRect();
      zoomBy(factor, event.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart]);

  // 键盘放缩（鼠标悬停在时间线上时）：+/- 放缩，0 复位
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!hoverRef.current) return;
      const tag = (event.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.15);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomBy(1 / 1.15);
      } else if (event.key === '0') {
        event.preventDefault();
        zoomBy(PX_PER_MINUTE_DEFAULT / ppmRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart]);

  // ===== 边缘拖拽改时间 / 整块平移（5 分钟吸附） =====
  const applyDragMove = () => {
    dragRafRef.current = 0;
    const base = dragBaseRef.current;
    if (!base) return;
    const card = cardsRef.current.find((item) => item.id === base.id);
    if (!card) return;
    const raw = base.baseMinutes + (dragClientYRef.current - base.startY) / ppmRef.current;
    let value = snapMinutes(raw);
    if (base.edge === 'move') {
      // 整块平移：钳制在 00:00 ~ 23:59 之内，时长保持不变
      value = Math.min(Math.max(value, 0), DAY_MAX_MINUTES - base.baseDuration);
    } else {
      const other = base.edge === 'start' ? timeToMinutes(card.end) : timeToMinutes(card.start);
      if (base.edge === 'start') {
        value = Math.min(Math.max(value, 0), other - MIN_SLOT_MINUTES);
      } else {
        value = Math.max(Math.min(value, DAY_MAX_MINUTES), other + MIN_SLOT_MINUTES);
      }
    }
    base.latestValue = value;
    setDrag((prev) => (prev ? { ...prev, value } : prev));
  };

  const startResize = (event, item, edge) => {
    event.preventDefault();
    event.stopPropagation();
    const baseMinutes = edge === 'start' ? item.start : item.end;
    dragBaseRef.current = { id: item.card.id, edge, baseMinutes, startY: event.clientY, latestValue: baseMinutes };
    dragClientYRef.current = event.clientY;
    setDrag({ id: item.card.id, edge, value: baseMinutes });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
  };

  const onResizeMove = (event) => {
    if (!dragBaseRef.current) return;
    event.preventDefault();
    dragClientYRef.current = event.clientY;
    if (!dragRafRef.current) dragRafRef.current = requestAnimationFrame(applyDragMove);
  };

  // 按下方块主体（边缘手柄已 stopPropagation，不会进入这里）
  const startBlockMove = (event, item) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    movePendingRef.current = {
      id: item.card.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseStart: item.start,
      duration: item.end - item.start,
      active: false,
    };
  };

  const onBlockMove = (event) => {
    const pending = movePendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!pending.active) {
      const MOVE_THRESHOLD = 5;
      if (Math.abs(event.clientY - pending.startY) < MOVE_THRESHOLD
        && Math.abs(event.clientX - pending.startX) < MOVE_THRESHOLD) {
        return;
      }
      pending.active = true;
      dragBaseRef.current = {
        id: pending.id,
        edge: 'move',
        baseMinutes: pending.baseStart,
        baseDuration: pending.duration,
        startY: pending.startY,
        latestValue: pending.baseStart,
      };
      dragClientYRef.current = pending.startY;
      setDrag({ id: pending.id, edge: 'move', value: pending.baseStart });
      const block = blockRefs.current.get(pending.id);
      try { block?.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
    }
    event.preventDefault();
    dragClientYRef.current = event.clientY;
    if (!dragRafRef.current) dragRafRef.current = requestAnimationFrame(applyDragMove);
  };

  const finishBlockMove = (event) => {
    const pending = movePendingRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    movePendingRef.current = null;
    if (pending.active) finishResize();
  };

  const finishResize = () => {
    const base = dragBaseRef.current;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    dragBaseRef.current = null;
    setDrag(null);
    if (base && Number.isFinite(base.latestValue) && base.latestValue !== base.baseMinutes) {
      let patch;
      if (base.edge === 'move') {
        patch = {
          start: minutesToTimeText(base.latestValue),
          end: minutesToTimeText(base.latestValue + base.baseDuration),
        };
      } else {
        patch = base.edge === 'start'
          ? { start: minutesToTimeText(base.latestValue) }
          : { end: minutesToTimeText(base.latestValue) };
      }
      onChangeCard(base.id, patch);
    }
    // 拖拽松手合成的 click 不要再打开编辑浮层
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  // ===== 点击内联编辑 =====
  const selectedCard = selectedId ? cards.find((card) => card.id === selectedId) : null;

  const openEditor = (card) => {
    if (suppressClickRef.current) return;
    setSelectedId(card.id);
    setDraft({ start: card.start, end: card.end, type: card.type, name: card.name || '' });
    setDraftError('');
  };

  const closeEditor = () => {
    setSelectedId(null);
    setDraft(null);
    setEditorPos(null);
    setDraftError('');
  };

  // 浮层跟随方块位置（滚动、放缩、数据变化时重新定位并钳制在视口内）
  useLayoutEffect(() => {
    if (!selectedId || !draft) {
      setEditorPos(null);
      return;
    }
    const position = () => {
      const block = blockRefs.current.get(selectedId);
      const popover = popoverRef.current;
      const container = scrollRef.current;
      if (!block || !popover || !container) return;
      const rect = block.getBoundingClientRect();
      const pw = popover.offsetWidth || 236;
      const ph = popover.offsetHeight || 210;
      const left = Math.min(
        Math.max(rect.right + 10, 8),
        window.innerWidth - pw - 8
      );
      const top = Math.min(
        Math.max(rect.top, 8),
        window.innerHeight - ph - 8
      );
      setEditorPos({ left, top });
    };
    position();
    const el = scrollRef.current;
    el?.addEventListener('scroll', position);
    window.addEventListener('resize', position);
    return () => {
      el?.removeEventListener('scroll', position);
      window.removeEventListener('resize', position);
    };
  }, [selectedId, draft, draftError, ppm, cards]);

  const saveDraft = () => {
    if (!selectedId || !draft) return;
    const start = timeToMinutes(draft.start);
    const end = timeToMinutes(draft.end);
    if (start < 0 || end < 0 || end <= start) {
      setDraftError('请填写有效时间，且结束时间需晚于开始时间。');
      return;
    }
    const patch = {
      start: minutesToTimeText(start),
      end: minutesToTimeText(end),
      type: draft.type,
    };
    if (draft.type === 'break') patch.name = String(draft.name || '').trim() || '课间';
    onChangeCard(selectedId, patch);
    closeEditor();
  };

  const ticks = [];
  for (let m = rangeStart; m <= rangeEnd; m += tickStep) {
    const isHour = m % 60 === 0;
    ticks.push(
      <div
        key={m}
        className={`timeline-tick${isHour ? ' hour' : ''}`}
        style={{ top: `${(m - rangeStart) * ppm}px` }}
      >
        {isHour && <span className="timeline-tick-label">{minutesToTimeText(m)}</span>}
      </div>
    );
  }

  const zoomPct = Math.round((ppm / PX_PER_MINUTE_DEFAULT) * 100);

  return (
    <div
      className="timeline-panel"
      ref={panelRef}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      <div className="timeline-toolbar">
        <span className="timeline-title">时间线</span>
        {groupName && <span className="timeline-group">{groupName}</span>}
        <Button size="small" appearance="primary" onClick={onAddClass}>上课</Button>
        <Button size="small" onClick={onAddBreak}>课间</Button>
        <span className="timeline-zoom">
          <button type="button" className="timeline-zoom-btn" title="缩小（-）" onClick={() => zoomBy(1 / 1.15)}>−</button>
          <button
            type="button"
            className="timeline-zoom-value"
            title="恢复默认缩放（0）"
            onClick={() => zoomBy(PX_PER_MINUTE_DEFAULT / ppmRef.current)}
          >
            {zoomPct}%
          </button>
          <button type="button" className="timeline-zoom-btn" title="放大（+）" onClick={() => zoomBy(1.15)}>+</button>
        </span>
        {invalidCount > 0 && (
          <span className="timeline-hint">{invalidCount} 个时间段时间无效，未在时间线中显示</span>
        )}
      </div>
      <p className="timeline-tip">拖动方块中间可整体移动时间段，拖动上/下边缘修改时间（自动对齐 5 分钟，支持触屏）；点击方块编辑时间与类型；Ctrl + 滚轮（或 +/- 键）纵向放缩。</p>
      <div className={`timeline-scroll${drag ? ' dragging' : ''}`} ref={scrollRef}>
        {validItems.length === 0 ? (
          <div className="empty">暂无可显示的时间段，点击上方“上课 / 课间”添加。</div>
        ) : (
          <div className="timeline-canvas" style={{ height: `${canvasHeight}px` }}>
            {ticks}
            {validItems.map((item) => {
              const top = (item.start - rangeStart) * ppm;
              const height = (item.end - item.start) * ppm;
              const duration = item.end - item.start;
              const compact = height < 40;
              const isDragging = drag?.id === item.card.id;
              return (
                <div
                  key={item.card.id}
                  ref={(el) => {
                    if (el) blockRefs.current.set(item.card.id, el);
                    else blockRefs.current.delete(item.card.id);
                  }}
                  className={`timeline-block ${item.card.type}${compact ? ' compact' : ''}${isDragging ? ' dragging' : ''}${selectedId === item.card.id ? ' selected' : ''}`}
                  style={{ top: `${top}px`, height: `${height}px` }}
                  title="点击编辑该时间段，拖动可整体移动"
                  onClick={() => openEditor(item.card)}
                  onPointerDown={(event) => startBlockMove(event, item)}
                  onPointerMove={onBlockMove}
                  onPointerUp={finishBlockMove}
                  onPointerCancel={finishBlockMove}
                >
                  <span
                    className="timeline-resize-handle top"
                    onPointerDown={(event) => startResize(event, item, 'start')}
                    onPointerMove={onResizeMove}
                    onPointerUp={finishResize}
                    onPointerCancel={finishResize}
                  />
                  <div className="timeline-block-inner">
                    <div className="timeline-block-time">{item.card.start} – {item.card.end}</div>
                    {!compact && (
                      <div className="timeline-block-meta">
                        {item.card.type === 'class'
                          ? `上课 · ${duration} 分钟`
                          : `${item.card.name || '课间'} · ${duration} 分钟`}
                      </div>
                    )}
                  </div>
                  <span
                    className="timeline-resize-handle bottom"
                    onPointerDown={(event) => startResize(event, item, 'end')}
                    onPointerMove={onResizeMove}
                    onPointerUp={finishResize}
                    onPointerCancel={finishResize}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedCard && draft && (
        <>
          <div className="timeline-editor-backdrop" onMouseDown={closeEditor} />
          <div className="timeline-editor" ref={popoverRef} style={editorPos || { opacity: 0 }}>
            <div className="timeline-editor-title">编辑时间段</div>
            <div className="timeline-editor-row">
              <label>开始</label>
              <Input
                type="time"
                step="300"
                value={draft.start}
                onChange={(event) => { setDraftError(''); setDraft({ ...draft, start: event.target.value }); }}
              />
            </div>
            <div className="timeline-editor-row">
              <label>结束</label>
              <Input
                type="time"
                step="300"
                value={draft.end}
                onChange={(event) => { setDraftError(''); setDraft({ ...draft, end: event.target.value }); }}
              />
            </div>
            <div className="timeline-editor-row">
              <label>类型</label>
              <Select
                value={draft.type}
                  onChange={(event) => {
                    const type = event.target.value;
                    setDraftError('');
                    setDraft({
                      ...draft,
                      type,
                      name: type === 'break' && !String(draft.name || '').trim() ? '课间' : draft.name,
                    });
                  }}
              >
                <option value="class">上课</option>
                <option value="break">课间</option>
              </Select>
            </div>
            {draft.type === 'break' && (
              <div className="timeline-editor-row">
                <label>名称</label>
                <Input
                  placeholder="课间名称（如：大课间）"
                  value={draft.name}
                  onChange={(event) => { setDraftError(''); setDraft({ ...draft, name: event.target.value }); }}
                />
              </div>
            )}
            {draftError && <div className="timeline-editor-error">{draftError}</div>}
            <div className="timeline-editor-actions">
              <Button
                className="win-icon danger-outline"
                title="删除该时间段"
                onClick={() => { onRemoveCard(selectedId); closeEditor(); }}
                icon={<Svg size={15} viewBox="0 0 16 16" html={ICONS.trash} strokeWidth={1.3} />}
              />
              <span className="timeline-editor-spacer" />
              <Button size="small" onClick={closeEditor}>取消</Button>
              <Button size="small" appearance="primary" onClick={saveDraft}>完成</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function TimetablePage({
  groupNames,
  activeName,
  onSwitch,
  cards,
  onCardsChange,
  onAddGroup,
  onRenameGroup,
  invalidIndexes,
}) {
  const layoutRef = useRef(null);
  const navRef = useRef(null);
  const cardRef = useRef(null);
  const listRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  // 触屏手势生命周期跨越多次渲染，回调闭包里只能通过 ref 读取最新列表/拖拽 id
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const dragIdRef = useRef(null);
  const cardTouchGhost = useRef(null);
  const cardTouchGesture = useRef(null);
  // 时间表右侧两个独立子页：时间段列表 / 图形化时间线（偏好持久化）
  const [subView, setSubViewState] = useState(() => (
    localStorage.getItem('timetableSubView') === 'timeline' ? 'timeline' : 'list'
  ));
  const setSubView = (view) => {
    setSubViewState(view);
    localStorage.setItem('timetableSubView', view);
  };
  // 默认上课/课间时长（分钟）：编辑器级偏好，持久化到 localStorage
  const [classMinutes, setClassMinutes] = useState(() => localStorage.getItem('timetableDefaultClassMinutes') || '40');
  const [breakMinutes, setBreakMinutes] = useState(() => localStorage.getItem('timetableDefaultBreakMinutes') || '10');
  const badges = computeBadges(cards);

  const updateCard = (id, patch) => {
    onCardsChange(cards.map((card) => (card.id === id ? { ...card, ...patch } : card)));
  };

  const removeCard = (id) => {
    onCardsChange(cards.filter((card) => card.id !== id));
  };

  // 定位并闪烁列表中对应的卡片（时间线块点击时调用）
  const focusCard = (id) => {
    const index = cards.findIndex((card) => card.id === id);
    if (index < 0) return;
    const element = listRef.current?.querySelector(`[data-card-index="${index}"]`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.remove('flash');
    void element.offsetWidth;
    element.classList.add('flash');
  };

  // 新增时间段：开始时间 = 最后一个时间有效的卡片的结束时间（默认 08:00），
  // 结束时间 = 开始时间 + 左侧设置的默认上课/课间时长
  const addSlot = (type) => {
    let startMinutes = 8 * 60;
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      const end = timeToMinutes(cards[i].end);
      if (end >= 0) { startMinutes = end; break; }
    }
    const duration = type === 'class'
      ? parseDurationMinutes(classMinutes, 40)
      : parseDurationMinutes(breakMinutes, 10);
    const newCard = {
      id: createCardId(),
      type,
      start: minutesToTimeText(startMinutes),
      end: minutesToTimeText(startMinutes + duration),
      name: type === 'break' ? '课间' : '',
    };
    onCardsChange([...cards, newCard]);
    // 在列表页新增时定位到新卡片；在时间线页新增时停留当前页即可
    if (subView === 'list') {
      setTimeout(() => focusCard(newCard.id), 60);
    }
  };

  const moveBefore = (targetIndex) => {
    if (dragId === null) return;
    const from = cards.findIndex((card) => card.id === dragId);
    if (from < 0 || from === targetIndex) return;
    const next = [...cards];
    const [moved] = next.splice(from, 1);
    const insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, moved);
    onCardsChange(next);
  };

  const onListDragOver = (event) => {
    if (dragId === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const targetCard = event.target.closest?.('[data-card-index]');
    if (!targetCard || !listRef.current?.contains(targetCard)) {
      // 拖到列表末尾空白处：追加到最后
      if (listRef.current?.contains(event.target)) moveBefore(cards.length);
      return;
    }
    const rect = targetCard.getBoundingClientRect();
    const targetIndex = Number(targetCard.dataset.cardIndex);
    if (event.clientY < rect.top + rect.height / 2) {
      moveBefore(targetIndex);
    } else {
      moveBefore(targetIndex + 1);
    }
  };

  // 触屏拖拽卡片排序：HTML5 DnD 在触屏下不触发，用 pointer 手势实时重排
  const moveCardToIndex = (targetIndex, liveCards, activeId) => {
    if (!activeId) return;
    const from = liveCards.findIndex((card) => card.id === activeId);
    if (from < 0 || from === targetIndex) return;
    const next = [...liveCards];
    const [moved] = next.splice(from, 1);
    const insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, moved);
    onCardsChange(next);
  };

  const reorderCardAtPoint = (x, y) => {
    const list = listRef.current;
    if (!list) return;
    const liveCards = cardsRef.current;
    const activeId = dragIdRef.current;
    const hitEl = document.elementFromPoint(x, y);
    const targetCard = hitEl?.closest?.('[data-card-index]');
    if (!targetCard || !list.contains(targetCard)) {
      if (hitEl && list.contains(hitEl)) moveCardToIndex(liveCards.length, liveCards, activeId);
      return;
    }
    const rect = targetCard.getBoundingClientRect();
    const targetIndex = Number(targetCard.dataset.cardIndex);
    if (y < rect.top + rect.height / 2) moveCardToIndex(targetIndex, liveCards, activeId);
    else moveCardToIndex(targetIndex + 1, liveCards, activeId);
  };

  const onTouchDragCard = (event, card) => {
    if (event.pointerType === 'mouse') return;
    const sourceEl = event.currentTarget.closest('.timetable-card');
    if (!sourceEl) return;
    const gesture = beginPointerGesture(event, {
      threshold: 8,
      onActivate: ({ x, y }) => {
        dragIdRef.current = card.id;
        setDragId(card.id);
        sourceEl.classList.add('touch-dragging');
        cardTouchGhost.current = createDragGhost(sourceEl);
        cardTouchGhost.current.move(x, y);
        reorderCardAtPoint(x, y);
      },
      onMove: ({ x, y }) => {
        cardTouchGhost.current?.move(x, y);
        reorderCardAtPoint(x, y);
      },
      onEnd: () => {
        sourceEl.classList.remove('touch-dragging');
        cardTouchGhost.current?.dispose();
        cardTouchGhost.current = null;
        dragIdRef.current = null;
        setDragId(null);
      },
    });
    if (gesture) cardTouchGesture.current = gesture;
  };

  // 与旧版 applyTimetableLayout 相同的宽度钳制
  useLayoutEffect(() => {
    const apply = () => {
      const layout = layoutRef.current;
      const panel = cardRef.current;
      if (!layout || !panel) return;
      if (window.matchMedia('(max-width: 980px)').matches) {
        panel.style.width = '';
        panel.style.maxWidth = '';
        return;
      }
      const navWidth = navRef.current?.offsetWidth || 180;
      const finalWidth = Math.min(Math.max(320, layout.clientWidth - navWidth - 28), 900);
      panel.style.width = `${finalWidth}px`;
      panel.style.maxWidth = `${finalWidth}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  });

  return (
    <>
      <div className="page-header">
        <h2>时间表</h2>
        <p>配置不同日程下的时间段与类型。</p>
      </div>
      <div className="ce-toolbar" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onAddGroup}>新增时间表</Button>
      </div>
      <div className="timetable-layout" ref={layoutRef}>
        <aside className="timetable-nav" ref={navRef}>
          {groupNames.length === 0 && <div className="empty">暂无时间表</div>}
          {groupNames.map((name) => (
            <button
              type="button"
              key={name}
              className={`timetable-nav-item${name === activeName ? ' active' : ''}`}
              title={name}
              onClick={() => onSwitch(name)}
            >
              {name}
            </button>
          ))}
          <div className="timetable-defaults">
            <div className="defaults-heading">默认时长</div>
            <div className="defaults-row">
              <label htmlFor="ttDefaultClass">上课</label>
              <Input
                id="ttDefaultClass"
                type="number"
                min={1}
                max={240}
                value={classMinutes}
                onChange={(event) => {
                  setClassMinutes(event.target.value);
                  localStorage.setItem('timetableDefaultClassMinutes', event.target.value);
                }}
              />
              <span className="defaults-unit">分钟</span>
            </div>
            <div className="defaults-row">
              <label htmlFor="ttDefaultBreak">课间</label>
              <Input
                id="ttDefaultBreak"
                type="number"
                min={1}
                max={240}
                value={breakMinutes}
                onChange={(event) => {
                  setBreakMinutes(event.target.value);
                  localStorage.setItem('timetableDefaultBreakMinutes', event.target.value);
                }}
              />
              <span className="defaults-unit">分钟</span>
            </div>
          </div>
        </aside>
        <div className="day-editor">
          {groupNames.length === 0 && <div className="empty">暂无时间表</div>}
          {groupNames.length > 0 && (
            <>
              <div className="tt-view-tabs" role="tablist" aria-label="时间表视图切换">
                <button
                  type="button"
                  role="tab"
                  aria-selected={subView === 'list'}
                  className={`tt-view-tab${subView === 'list' ? ' active' : ''}`}
                  onClick={() => setSubView('list')}
                >
                  时间段列表
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={subView === 'timeline'}
                  className={`tt-view-tab${subView === 'timeline' ? ' active' : ''}`}
                  onClick={() => setSubView('timeline')}
                >
                  时间线
                </button>
              </div>
              {subView === 'list' && (
                <div className="group-card" ref={cardRef} data-timetable-name={activeName}>
                  <h3>{activeName}</h3>
                  <p className="field-help timetable-help">
                    上课时间段无需填写节次，保存时按开始时间自动从第 1 节开始编号；拖动卡片左侧手柄可调整时间段的显示顺序。
                  </p>
                  <div
                    className="timetable-card-list"
                    ref={listRef}
                    onDragOver={onListDragOver}
                    onDrop={(event) => { if (dragId !== null) event.preventDefault(); }}
                  >
                    {cards.length === 0 && (
                      <div className="empty">暂无时间段，点击下方“新增上课 / 新增课间”添加。</div>
                    )}
                    {cards.map((card, index) => (
                      <TimetableCard
                        key={card.id}
                        card={card}
                        index={index}
                        badge={badges.get(card.id)}
                        invalid={invalidIndexes.has(index)}
                        draggableEnabled={dragId === card.id}
                        onPointerDownHandle={() => setDragId(card.id)}
                        onTouchDragHandle={(event) => onTouchDragCard(event, card)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          try { event.dataTransfer.setData('text/plain', ''); } catch (error) { /* 忽略 */ }
                        }}
                        onDragEnd={() => setDragId(null)}
                        onChange={(patch) => updateCard(card.id, patch)}
                        onRemove={() => removeCard(card.id)}
                      />
                    ))}
                  </div>
                  <div className="row-actions">
                    <Button appearance="primary" onClick={() => addSlot('class')}>新增上课</Button>
                    <Button onClick={() => addSlot('break')}>新增课间</Button>
                    <Button onClick={() => onRenameGroup(activeName)}>重命名</Button>
                  </div>
                </div>
              )}
              {subView === 'timeline' && (
                <TimelineView
                  cards={cards}
                  groupName={activeName}
                  onAddClass={() => addSlot('class')}
                  onAddBreak={() => addSlot('break')}
                  onChangeCard={updateCard}
                  onRemoveCard={removeCard}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
