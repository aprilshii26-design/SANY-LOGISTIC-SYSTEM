/* SANY Global Transition Manager - additive presentation layer. */
@keyframes sanyPageEnterV1 {
  from { opacity: 0; transform: translate3d(0, 10px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}

main.container.sany-page-enter {
  animation: sanyPageEnterV1 220ms cubic-bezier(.2,.75,.25,1) both;
}

/* Keep motion compositing lightweight and avoid animating form controls individually. */
main.container.sany-page-enter #reader,
main.container.sany-page-enter video,
main.container.sany-page-enter canvas {
  animation: none !important;
}

@media (prefers-reduced-motion: reduce) {
  main.container.sany-page-enter { animation: none !important; }
}
