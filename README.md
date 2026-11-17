# Wall Fit — 실측 액자 배치 시뮬레이터

벽 사진 속 크기를 아는 물체(액자, 타일, A4 등)로 사진의 원근을 계산해서, 새 액자를 실제 cm 크기 그대로 배치해 볼 수 있는 웹앱입니다.

**사용하기:** https://ire4564.github.io/kimwood_zip_page/

## 주요 기능
- 사진 보정: 회전 · 수직/수평 원근 (사진 편집 앱처럼 자동 크롭, 보정 전/후 비교)
- 기준 지정: 크기를 아는 물체 여러 개를 함께 써서 원근·축척을 추정 (번들 조정)
- 액자 배치: cm 단위 배치, 회전, 자석 정렬, 옆 액자와의 간격 표시
- 길이 측정, 원본 해상도 PNG 저장, 프로젝트 파일 저장/열기
- ⌘/Ctrl+Z 되돌리기 (단계별)

사진과 작업 내용은 브라우저(IndexedDB)에만 저장되고 서버로 전송되지 않습니다.

## 개발
```bash
npm install
npm run dev
```

## 배포
`main` 브랜치에 push하면 GitHub Actions가 빌드해서 GitHub Pages에 배포합니다 (`.github/workflows/deploy.yml`).
