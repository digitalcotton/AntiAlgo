"""
Main Pipeline Orchestrator

Coordinates the full curiosity intelligence workflow:
1. Ingest questions from all sources
2. Normalize and embed
3. Cluster similar questions
4. Detect signals
5. Correlate with news
6. Generate digest
"""

import asyncio
import os
from datetime import datetime, timedelta
from typing import Optional
from dataclasses import dataclass

import click
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn
from dotenv import load_dotenv

from .ingestion import RedditIngester, StackExchangeIngester
from .processing import QuestionNormalizer, QuestionEmbedder, QuestionClusterer
from .analysis import SignalDetector, NewsCorrelator
from .output import DigestGenerator
from .database import Database


console = Console()


@dataclass
class PipelineConfig:
    """Configuration for pipeline run."""
    week_start: datetime
    lookback_days: int = 7
    signal_threshold: float = 0.70
    similarity_threshold: float = 0.85
    max_signals: int = 10
    include_weird_picks: bool = True
    dry_run: bool = False


class CuriosityPipeline:
    """
    Main orchestrator for the Curiosity Intelligence Engine.
    
    Transforms raw questions from Reddit, Stack Exchange, etc. into
    a ranked list of trending curiosity signals with news correlation.
    """
    
    def __init__(self, config: Optional[PipelineConfig] = None):
        load_dotenv()
        
        self.config = config or PipelineConfig(
            week_start=self._get_week_start()
        )
        
        # Initialize components
        self.db = Database()
        self.normalizer = QuestionNormalizer()
        self.embedder = QuestionEmbedder()
        self.clusterer = QuestionClusterer()
        self.signal_detector = SignalDetector(
            threshold=self.config.signal_threshold
        )
        self.news_correlator = NewsCorrelator()
        self.digest_generator = DigestGenerator()
        
        # Ingesters
        self.ingesters = [
            RedditIngester(),
            StackExchangeIngester(),
        ]
    
    def _get_week_start(self) -> datetime:
        """Get Monday of current week."""
        today = datetime.utcnow()
        return today - timedelta(days=today.weekday())
    
    async def run(self) -> dict:
        """
        Execute full pipeline.
        
        Returns:
            Summary of pipeline run with signals and stats
        """
        console.print("\n[bold blue]🧠 Curiosity Intelligence Engine[/bold blue]")
        console.print(f"Week: {self.config.week_start.strftime('%Y-W%W')}\n")
        
        results = {
            "week": self.config.week_start.isoformat(),
            "questions_ingested": 0,
            "clusters_created": 0,
            "signals_detected": 0,
            "signals": [],
            "weird_picks": [],
        }
        
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            
            # Step 1: Ingest
            task = progress.add_task("Ingesting questions...", total=None)
            questions = await self._ingest_all()
            results["questions_ingested"] = len(questions)
            progress.update(task, description=f"✓ Ingested {len(questions)} questions")
            
            if not questions:
                console.print("[yellow]No questions found. Exiting.[/yellow]")
                return results
            
            # Step 2: Normalize
            task = progress.add_task("Normalizing...", total=None)
            normalized = [
                {
                    **q,
                    "normalized_text": self.normalizer.normalize(
                        q["raw_text"], 
                        q["platform"]
                    )
                }
                for q in questions
            ]
            progress.update(task, description="✓ Normalized questions")
            
            # Step 3: Embed
            task = progress.add_task("Generating embeddings...", total=None)
            texts = [q["normalized_text"] for q in normalized]
            embeddings = await self.embedder.embed_batch(texts)
            for i, q in enumerate(normalized):
                q["embedding"] = embeddings[i]
            progress.update(task, description="✓ Generated embeddings")
            
            # Step 4: Cluster
            task = progress.add_task("Clustering questions...", total=None)
            clusters = self.clusterer.cluster(normalized)
            results["clusters_created"] = len(clusters)
            progress.update(task, description=f"✓ Created {len(clusters)} clusters")
            
            # Step 5: Detect signals
            task = progress.add_task("Detecting signals...", total=None)
            signals = self.signal_detector.detect(clusters)
            results["signals_detected"] = len([s for s in signals if s.is_signal])
            progress.update(task, description=f"✓ Detected {results['signals_detected']} signals")
            
            # Step 6: Correlate with news
            task = progress.add_task("Correlating with news...", total=None)
            for signal in signals[:self.config.max_signals]:
                if signal.is_signal:
                    news = await self.news_correlator.find_trigger(
                        signal.canonical_question,
                        self.config.week_start
                    )
                    signal.news_trigger = news
            progress.update(task, description="✓ Correlated with news")
            
            # Step 7: Get weird picks
            if self.config.include_weird_picks:
                task = progress.add_task("Finding weird picks...", total=None)
                weird = self.signal_detector.get_weird_picks(clusters)
                results["weird_picks"] = [w.to_dict() for w in weird[:3]]
                progress.update(task, description=f"✓ Found {len(weird)} weird picks")
            
            # Step 8: Save results
            if not self.config.dry_run:
                task = progress.add_task("Saving to database...", total=None)
                await self.db.save_run(results, clusters, signals)
                progress.update(task, description="✓ Saved to database")
            
            # Prepare output
            results["signals"] = [
                s.to_dict() 
                for s in signals[:self.config.max_signals] 
                if s.is_signal
            ]
        
        # Print summary
        self._print_summary(results)
        
        return results
    
    async def _ingest_all(self) -> list:
        """Ingest from all sources concurrently."""
        tasks = [
            ingester.ingest(
                since=self.config.week_start - timedelta(days=self.config.lookback_days)
            )
            for ingester in self.ingesters
        ]
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        questions = []
        for result in results:
            if isinstance(result, Exception):
                console.print(f"[red]Ingestion error: {result}[/red]")
            else:
                questions.extend(result)
        
        return questions
    
    def _print_summary(self, results: dict):
        """Print run summary."""
        console.print("\n" + "=" * 60)
        console.print("[bold green]✓ Pipeline Complete[/bold green]\n")
        
        console.print(f"Questions ingested: {results['questions_ingested']}")
        console.print(f"Clusters created:   {results['clusters_created']}")
        console.print(f"Signals detected:   {results['signals_detected']}")
        
        if results["signals"]:
            console.print("\n[bold]Top Signals:[/bold]")
            for i, signal in enumerate(results["signals"][:5], 1):
                tier_emoji = {"breakout": "🔥", "strong": "⭐", "signal": "📊"}.get(
                    signal.get("tier", ""), "📈"
                )
                console.print(
                    f"  {i}. {tier_emoji} {signal['question'][:50]}... "
                    f"({signal['velocity_pct']:+.0f}%)"
                )
        
        if results["weird_picks"]:
            console.print("\n[bold]Weird Picks:[/bold]")
            for pick in results["weird_picks"]:
                console.print(f"  🤔 {pick['question'][:50]}...")


# ============================================
# CLI
# ============================================

@click.command()
@click.option("--week", default=None, help="Week to process (YYYY-WNN format)")
@click.option("--dry-run", is_flag=True, help="Don't save to database")
@click.option("--test", is_flag=True, help="Run with minimal data for testing")
def main(week: Optional[str], dry_run: bool, test: bool):
    """Run the Curiosity Intelligence pipeline."""
    
    config = PipelineConfig(
        week_start=datetime.strptime(week + "-1", "%Y-W%W-%w") if week else None,
        dry_run=dry_run,
    )
    
    if config.week_start is None:
        config.week_start = datetime.utcnow() - timedelta(
            days=datetime.utcnow().weekday()
        )
    
    pipeline = CuriosityPipeline(config)
    
    try:
        asyncio.run(pipeline.run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Pipeline interrupted.[/yellow]")
    except Exception as e:
        console.print(f"\n[red]Pipeline failed: {e}[/red]")
        raise


if __name__ == "__main__":
    main()
