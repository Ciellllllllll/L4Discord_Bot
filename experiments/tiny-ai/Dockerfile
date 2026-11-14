FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
RUN pip install --no-cache-dir torch==2.6.0+cpu --index-url https://download.pytorch.org/whl/cpu
WORKDIR /app
COPY model.py run.py quality.py benchmark_data.py test_model.py test_benchmark_data.py test_quality.py test_pipeline.py test_generation.py ./
ENTRYPOINT ["python", "run.py"]
