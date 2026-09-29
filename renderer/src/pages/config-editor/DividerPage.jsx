import { Input } from '@fluentui/react-components';

export default function DividerPage({ config, dividerTexts, onChangeText }) {
  // 以“时间表”页面中的所有时间表为准：无论 divider 中是否已有配置，
  // 每个时间表都呈现一张卡片（新增时间表自动出现、删除时间表自动消失），
  // 顺序与时间表页一致。
  const groups = config && config.divider ? config.divider : {};
  const timetableGroups = config && config.timetable ? config.timetable : {};
  const groupNames = Object.keys(timetableGroups);

  return (
    <>
      <div className="page-header">
        <h2>分割线</h2>
        <p>配置不同时间表中的视觉分隔线位置。</p>
      </div>
      <div className="panel">
        <div className="card-grid">
          {groupNames.length === 0 && <div className="empty">暂无时间表，请先在“时间表”中新增</div>}
          {groupNames.map((name) => (
            <div className="group-card" key={name}>
              <h3>{name}</h3>
              <div className="field divider-field">
                <label htmlFor={`divider-${name}`}>分割线位置（逗号分隔）</label>
                <Input
                  id={`divider-${name}`}
                  value={dividerTexts[name] !== undefined
                    ? dividerTexts[name]
                    : (groups[name] || []).join(', ')}
                  onChange={(event) => onChangeText(name, event.target.value)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
