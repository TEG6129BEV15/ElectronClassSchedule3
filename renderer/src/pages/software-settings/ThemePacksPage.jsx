import { useCallback, useEffect, useState } from 'react';
import { Button, Switch, Textarea } from '@fluentui/react-components';
import { ipcRenderer } from '../../common/electron.js';
import { Svg, ICONS } from '../../common/icons.jsx';

// “主题”页：
// 1. 扫描 Theme 文件夹，每个含 index.json 的子文件夹显示为一个主题开关。
//    最多启用一个开关（单选语义）；全部关闭时加载默认主题。
// 2. 自定义样式：任意 CSS 文本，保存后注入到主界面 head 末尾（优先级最高），
//    可完全覆盖 css/style.css 与主题包（背景、颜色、字体、布局等）。
export default function ThemePacksPage({ activeTheme, onSelectTheme, customCss, onChangeCustomCss }) {
  const [packs, setPacks] = useState([]);
  const [referenceCss, setReferenceCss] = useState(null);

  const reloadPacks = useCallback(() => {
    ipcRenderer.invoke('list-theme-packs')
      .then((list) => setPacks(Array.isArray(list) ? list : []))
      .catch((error) => console.error('读取主题列表失败:', error));
  }, []);

  useEffect(() => {
    reloadPacks();
    // 用户直接在 Theme 文件夹里增删子文件夹后，切回本窗口即静默刷新列表
    const onFocus = () => reloadPacks();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reloadPacks]);

  const loadReferenceCss = () => {
    if (referenceCss !== null) return;
    ipcRenderer.invoke('read-main-css-file')
      .then((css) => setReferenceCss(typeof css === 'string' ? css : ''))
      .catch((error) => {
        console.error('读取默认样式失败:', error);
        setReferenceCss('/* 读取 css/style.css 失败 */');
      });
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">主题</h1>
        <p className="page-intro">
          每个主题是 Theme 文件夹中的一个子文件夹（含 index.json 索引、css 文件与字体）。
          同一时间只能启用一个主题；全部关闭时使用默认外观。
        </p>
      </div>
      <div className="panel">
        <div className="theme-packs-toolbar">
          <h3>已安装主题</h3>
          <Button
            className="win-small"
            icon={<Svg size={16} viewBox="0 0 24 24" html={ICONS.folder} />}
            onClick={() => ipcRenderer.send('open-theme-folder')}
          >
            打开 Theme 文件夹
          </Button>
        </div>
        {packs.length === 0 ? (
          <div className="empty theme-packs-empty">
            Theme 文件夹中还没有主题。点击右上角“打开 Theme 文件夹”，
            把包含 index.json 的主题子文件夹放进去，回到此页面即可看到开关。
          </div>
        ) : (
          <div className="theme-pack-list">
            {packs.map((pack) => {
              const checked = activeTheme === pack.id;
              return (
                <div
                  key={pack.id}
                  className={`theme-pack-card${checked ? ' active' : ''}`}
                  onClick={() => onSelectTheme(checked ? '' : pack.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectTheme(checked ? '' : pack.id);
                    }
                  }}
                >
                  <div className="theme-pack-info">
                    <div className="theme-pack-name">{pack.id}</div>
                    <div className="theme-pack-meta">
                      {pack.css.length} 个样式文件 · {pack.fonts.length} 个字体
                    </div>
                  </div>
                  <Switch
                    checked={checked}
                    aria-label={`启用主题 ${pack.id}`}
                    onChange={(_event, data) => onSelectTheme(data.checked ? pack.id : '')}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>
        )}
        <p className="field-help">
          新增或删除主题文件夹后，重新打开此页面即可刷新列表。
        </p>
      </div>

      <div className="panel custom-css-panel">
        <div className="theme-packs-toolbar">
          <h3>自定义样式</h3>
          {customCss && (
            <Button className="win-small" onClick={() => onChangeCustomCss('')}>清空</Button>
          )}
        </div>
        <p className="field-help custom-css-help">
          在此编写任意 CSS，保存后立即生效并作用于主界面；样式优先级高于默认 style.css
          与上方启用的主题包，相当于对默认样式的完全重构。可修改背景与配色，例如
          <code>:root &#123; --bg-base: #101014; --col-current: #4cc2ff; &#125;</code>、
          <code>.background &#123; background-image: url('file:///C:/Users/you/bg.jpg'); background-size: cover; &#125;</code>
          （本地图片用 file:/// 路径，网络图片直接写 https:// 链接）。
        </p>
        <Textarea
          className="style-editor"
          value={customCss || ''}
          placeholder={'/* 示例：\n:root {\n  --bg-base: #101014;\n  --col-current: #4cc2ff;\n}\n.background {\n  background-image: url("file:///C:/Users/you/Pictures/bg.jpg");\n  background-size: cover;\n} */'}
          onChange={(event) => onChangeCustomCss(event.target.value)}
        />
        <details className="custom-css-reference" onToggle={(event) => event.target.open && loadReferenceCss()}>
          <summary>查看默认 style.css 作为编写参考</summary>
          {referenceCss !== null && (
            <pre className="custom-css-reference-code"><code>{referenceCss}</code></pre>
          )}
        </details>
      </div>
    </>
  );
}
