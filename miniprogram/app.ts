import { appService } from './services/app.service';

App({
  onLaunch() {
    try {
      appService.bootstrap();
    } catch (error) {
      console.error('冰箱有数初始化失败', error);
    }
  },
});
