FROM shipyard.vail/python:3.12

WORKDIR /app
COPY requirements.txt requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY . .

ENV FLASK_APP=main.py
EXPOSE 5001
ENTRYPOINT ["flask", "run", "--with-threads", "--port=5001", "--host=0.0.0.0"]
