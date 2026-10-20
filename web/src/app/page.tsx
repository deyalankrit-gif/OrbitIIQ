export default function Home() {
  return (
    <main className="landing">
      <section className="landing-card">
        <div className="brand-mark" aria-hidden="true">✳</div>
        <p className="eyebrow">OrbitIQ · Next.js app</p>
        <h1>Your learning space starts here.</h1>
        <p className="intro">
          The Next.js application is running. Account features are not included
          in this version.
        </p>
        <div className="command">
          <span>Start the existing Node app from the project root</span>
          <code>npm start</code>
        </div>
      </section>
      <footer>OrbitIQ</footer>
    </main>
  );
}
