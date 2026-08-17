import DefaultTheme from 'vitepress/theme';
import HomeCompare from './components/HomeCompare.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeCompare', HomeCompare);
  },
};
