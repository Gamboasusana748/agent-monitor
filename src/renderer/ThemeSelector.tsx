import { useState } from 'react';
import { Dropdown } from './Dropdown';
import { readTheme, saveTheme, THEMES, type Theme } from './theme';

export function ThemeSelector() {
  const [theme, setTheme] = useState(readTheme);
  return <Dropdown label="Theme" value={theme} options={THEMES.map(option => ({ value: option.id, label: option.label }))}
    onChange={value => {
      const next = value as Theme;
      setTheme(next);
      saveTheme(next);
    }} />;
}
